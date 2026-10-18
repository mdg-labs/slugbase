import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";

// The order in which the redemption of an emailed token and the issue of a new one lock the rows they share
// (doc 05 section 3.3, doc 02 sections 2.5 and 2.6). Issuing locks the account row and then deletes the
// account's older unused tokens of the purpose; a redemption that took the token row first and the account row
// second would wait on the issue while the issue waits on it, and the database would abort one of the two with a
// deadlock error. The failure scenario: a link opened while a newer one is being issued for the same account
// turns into a server error, or aborts the issue.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const HOUR_SECONDS = 3_600;
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$bmV3";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE accounts CASCADE`;
});

interface Redemption {
  readonly name: "sys_email_verify" | "sys_password_reset";
  readonly purpose: "email_verify" | "password_reset";
}

const redemptions: readonly Redemption[] = [
  { name: "sys_email_verify", purpose: "email_verify" },
  { name: "sys_password_reset", purpose: "password_reset" },
];

/** A verified account with a password, which both redemptions accept. */
async function account(): Promise<string> {
  const id = freshId();
  await seedAccount(db, { id, email: `lock-order-${id}@example.test`, passwordHash: PASSWORD_HASH });
  await asSystem(db, (tx) => tx`UPDATE accounts SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

async function issue(accountId: string, purpose: string): Promise<Buffer> {
  const { hash } = freshToken();
  const result = await db.app`
    SELECT sys_credential_token_issue(${freshId()}::uuid, ${purpose}::text, ${accountId}::uuid, ${hash}::bytea, NULL::text, ${HOUR_SECONDS}::integer) AS issued`;
  expect(result[0]?.["issued"]).toBe(true);
  return hash;
}

function redeem(redemption: Redemption, tokenHash: Buffer): Promise<readonly unknown[]> {
  const call = db.app.unsafe(`SELECT * FROM public.${redemption.name}($1::bytea, $2::text, $3::uuid, $4::bytea, NULL::cidr, NULL::text, NULL::bytea)`, [
    tokenHash,
    PASSWORD_HASH,
    freshId(),
    freshToken().hash,
  ]);
  return call.then((rows) => [...rows]);
}

/** How many backends of this database wait for a lock, which is where a redemption queued behind the account row stands. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilBlocked(): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) === 0) {
    if (Date.now() > deadline) {
      throw new Error("the redemption never waited for a lock");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe.each(redemptions)("$name against an issue for the same account", (redemption) => {
  it(
    "queues behind the issue, answers nothing for the token the issue replaced and aborts neither, and the newer token redeems",
    async () => {
      const owner = await account();
      const older = await issue(owner, redemption.purpose);

      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const accountLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let newer: Buffer | undefined;

      // The issuing transaction: it holds the account row, as sys_credential_token_issue takes it first.
      const issuing = db.owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`SELECT 1 FROM accounts WHERE id = ${owner} FOR UPDATE`;
        locked();
        await released;
        newer = freshToken().hash;
        const issued = await tx`
          SELECT sys_credential_token_issue(${freshId()}::uuid, ${redemption.purpose}::text, ${owner}::uuid, ${newer}::bytea, NULL::text, ${HOUR_SECONDS}::integer) AS issued`;
        expect(issued[0]?.["issued"]).toBe(true);
      });
      const issuingSettled = issuing.then(
        () => undefined,
        (error: unknown) => ({ error }),
      );

      await accountLocked;
      const redeeming = redeem(redemption, older);
      const redeemingSettled = redeeming.then(
        (rows) => ({ rows }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitUntilBlocked();
      } finally {
        release();
      }

      const [issueOutcome, redeemOutcome] = await Promise.all([issuingSettled, redeemingSettled]);

      expect(issueOutcome).toBeUndefined();
      expect(redeemOutcome).toEqual({ rows: [] });
      expect(newer).toBeDefined();
      expect(await redeem(redemption, newer ?? Buffer.alloc(0))).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});
