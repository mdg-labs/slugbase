import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CREDENTIAL_TOKEN_TTL_SECONDS, type CredentialTokenPurpose } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FixedClock, InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { CREDENTIAL_ENV, redeemFlows, requestFlows, type RedeemFlow } from "./credential-flows.ts";
import { freshSessionCookie, seedAccount, serveAuth, storeFor, type AuthWorld, type SeededAccount } from "./support.ts";

// The emailed single-use tokens (doc 02 sections 2.5, 2.6 and 16, doc 04 sections 10.2 and 10.3, doc 10 T4, T8 and
// T9, Q48), through the requests that ask for a link, the worker that issues the token and mails it, and the
// requests that redeem it. The failure scenarios: a token that lives longer or shorter than its purpose says; one
// that works twice; an older one that outlives a newer request; a token kept in the database, the queue or a log
// as anything but its hash; a link whose token travels in a place a server log or a Referer header would hold it.

const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 40_000;
const MINUTE_SECONDS = 60;

const database = useTestDatabase();
const mail = new InMemoryMail();
const workerLogs = recordingLogger();
const captured: string[] = [];
let store: AuthStore;
let worker: RunningWorker | undefined;
let expectedJobs = 0;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: {
      ...adapters(),
      mail,
      errors: {
        available: true,
        capture: (error) => {
          captured.push(String(error));
          return Promise.resolve();
        },
      },
    },
    modules: [],
    logger: workerLogs,
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await worker?.shutdown();
  await store.close();
}, 30_000);

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`DELETE FROM pgboss.job WHERE name = 'mail.send'`;
  mail.clear();
  workerLogs.entries.length = 0;
  workerLogs.requests.length = 0;
  captured.length = 0;
  expectedJobs = 0;
});

function serve(): AuthWorld {
  return serveAuth(database(), store, { env: CREDENTIAL_ENV, mail });
}

interface TokenRow {
  readonly purpose: string;
  readonly token_hash: Buffer;
  readonly used_at: Date | null;
  readonly created_at: Date;
  readonly lifetime_seconds: number;
}

async function tokenRows(accountId: string): Promise<TokenRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<TokenRow[]>`
      SELECT purpose, token_hash, used_at, created_at, extract(epoch FROM expires_at - created_at)::float8 AS lifetime_seconds
      FROM credential_tokens WHERE account_id = ${accountId} ORDER BY created_at, id`;
  });
  return [...rows];
}

/** Every row of the table as the text a dump of it would hold. */
async function tableText(): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ text: string }[]>`SELECT t::text AS text FROM credential_tokens t`;
  });
  return rows.map((row) => row.text).join("\n");
}

/**
 * Makes the database read `clock` as the time of the account's tokens: every instant they recorded moves back by how
 * far `clock` has advanced since `from`, which is the moment they were issued.
 */
async function travel(accountId: string, from: Date, clock: FixedClock): Promise<void> {
  const seconds = (clock.now().getTime() - from.getTime()) / 1000;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      UPDATE credential_tokens
      SET created_at = created_at - make_interval(secs => ${seconds}), expires_at = expires_at - make_interval(secs => ${seconds})
      WHERE account_id = ${accountId}`;
  });
}

async function waitForMail(): Promise<void> {
  expectedJobs += 1;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const rows = await database().app<{ state: string }[]>`SELECT state FROM pgboss.job WHERE name = 'mail.send'`;
    if (rows.length >= expectedJobs && rows.every((row) => row.state === "completed")) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the mail jobs");
    }
    await sleep(50);
  }
}

/** The token the newest message of the template carries. */
function newestToken(template: string): string {
  const message = mail.sent.filter((candidate) => candidate.template === template).at(-1);
  if (message === undefined) {
    throw new Error(`no ${template} mail was sent`);
  }
  return String(message.data["token"]);
}

const bytesHash = (token: string): Buffer => createHash("sha256").update(Buffer.from(token, "base64url")).digest();

function flow<T extends { readonly path: string }>(flows: readonly T[], path: string): T {
  const found = flows.find((candidate) => candidate.path.endsWith(path));
  if (found === undefined) {
    throw new Error(`no flow for ${path}`);
  }
  return found;
}

const resend = flow(requestFlows, "/verify-email/resend");
const forgot = flow(requestFlows, "/password/forgot");
const changeEmail = flow(requestFlows, "/me/email");
const verify = flow(redeemFlows, "/auth/verify-email");
const reset = flow(redeemFlows, "/password/reset");
const confirm = flow(redeemFlows, "/email/confirm");
const cancel = flow(redeemFlows, "/email/cancel");

interface Scenario {
  readonly account: SeededAccount;
  /** Asks for the link once more and waits for the worker to mail it. */
  readonly ask: () => Promise<void>;
}

interface Case {
  readonly name: string;
  readonly purpose: CredentialTokenPurpose;
  /** The lifetime the design settles (Q48), written here and not read from the code under test. */
  readonly lifetimeSeconds: number;
  /** The mail template whose message carries the token. */
  readonly template: string;
  readonly redeem: RedeemFlow;
  readonly prepare: (world: AuthWorld) => Promise<Scenario>;
}

let accountNumber = 0;

const cases: readonly Case[] = [
  {
    name: "the verification link",
    purpose: "email_verify",
    lifetimeSeconds: 24 * 60 * MINUTE_SECONDS,
    template: "verifyEmail",
    redeem: verify,
    prepare: async (world) => {
      const account = await seedAccount(database(), { emailVerified: false });
      return {
        account,
        ask: async () => {
          expect((await resend.call(world, account.email, {})).status).toBe(202);
          await waitForMail();
        },
      };
    },
  },
  {
    name: "the password-reset link",
    purpose: "password_reset",
    lifetimeSeconds: 60 * MINUTE_SECONDS,
    template: "passwordReset",
    redeem: reset,
    prepare: async (world) => {
      const account = await seedAccount(database(), { emailVerified: true });
      return {
        account,
        ask: async () => {
          expect((await forgot.call(world, account.email, {})).status).toBe(202);
          await waitForMail();
        },
      };
    },
  },
  {
    name: "the email-change confirmation link",
    purpose: "email_change",
    lifetimeSeconds: 60 * MINUTE_SECONDS,
    template: "emailChange",
    redeem: confirm,
    prepare: async (world) => changeScenario(world),
  },
  {
    name: "the email-change \"this wasn't me\" link",
    purpose: "email_change_cancel",
    lifetimeSeconds: 60 * MINUTE_SECONDS,
    template: "emailChangeNotice",
    redeem: cancel,
    prepare: async (world) => changeScenario(world),
  },
];

async function changeScenario(world: AuthWorld): Promise<Scenario> {
  const account = await seedAccount(database(), { emailVerified: true });
  const cookie = await freshSessionCookie(world, account);
  return {
    account,
    ask: async () => {
      accountNumber += 1;
      expect((await changeEmail.call(world, `moving.to.${String(accountNumber)}@example.test`, {}, cookie)).status).toBe(202);
      await waitForMail();
    },
  };
}

const caseTable = cases.map((entry) => [entry.name, entry] as const);

describe("the lifetime, the single use and the storage of an emailed token", { timeout: TEST_TIMEOUT_MS }, () => {
  it("settles the lifetimes of Q48: the verification link 24 hours, the others 1 hour", () => {
    expect(cases.map((entry) => [entry.purpose, CREDENTIAL_TOKEN_TTL_SECONDS[entry.purpose]])).toEqual(cases.map((entry) => [entry.purpose, entry.lifetimeSeconds]));
  });

  it.each(caseTable)("%s: is stored only as the SHA-256 of its bytes, unused, with the lifetime of its purpose", async (_name, entry) => {
    const world = serve();
    const { account, ask } = await entry.prepare(world);

    await ask();

    const token = newestToken(entry.template);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = (await tokenRows(account.id)).filter((row) => row.purpose === entry.purpose);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toEqual(bytesHash(token));
    expect(stored[0]?.used_at).toBeNull();
    expect(stored[0]?.lifetime_seconds).toBeCloseTo(entry.lifetimeSeconds, 0);
    const dump = await tableText();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(Buffer.from(token, "base64url").toString("hex"));
  });

  const moments = [
    { moment: "a minute before its lifetime is up", afterSeconds: (lifetime: number) => lifetime - MINUTE_SECONDS, works: true },
    { moment: "a second after its lifetime is up", afterSeconds: (lifetime: number) => lifetime + 1, works: false },
  ] as const;

  it.each(cases.flatMap((entry) => moments.map((moment) => [`${entry.name}, ${moment.moment}`, entry, moment] as const)))(
    "%s",
    async (_name, entry, { afterSeconds, works }) => {
      const world = serve();
      const { account, ask } = await entry.prepare(world);
      await ask();
      const token = newestToken(entry.template);
      const issued = (await tokenRows(account.id))[0]?.created_at ?? new Date(0);
      const clock = new FixedClock(issued);

      clock.advance(afterSeconds(entry.lifetimeSeconds) * 1000);
      await travel(account.id, issued, clock);
      const response = await entry.redeem.call(world, token);

      expect(response.status).toBe(works ? entry.redeem.success : 410);
      const rows = (await tokenRows(account.id)).filter((row) => row.purpose === entry.purpose);
      expect(rows.map((row) => row.used_at !== null)).toEqual([works]);
    },
  );

  it.each(caseTable)("%s: works once, and the second redemption is the one 410", async (_name, entry) => {
    const world = serve();
    const { account, ask } = await entry.prepare(world);
    await ask();
    const token = newestToken(entry.template);

    expect((await entry.redeem.call(world, token)).status).toBe(entry.redeem.success);
    const replay = await entry.redeem.call(world, token);

    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ code: "token_expired", status: 410 });
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect((await tokenRows(account.id)).filter((row) => row.purpose === entry.purpose && row.used_at !== null)).toHaveLength(1);
  });

  it.each(caseTable)("%s: issuing a newer token invalidates the older unused one", async (_name, entry) => {
    const world = serve();
    const { account, ask } = await entry.prepare(world);
    await ask();
    const older = newestToken(entry.template);
    await ask();
    const newer = newestToken(entry.template);

    expect(newer).not.toBe(older);
    const unused = (await tokenRows(account.id)).filter((row) => row.purpose === entry.purpose && row.used_at === null);
    expect(unused.map((row) => row.token_hash)).toEqual([bytesHash(newer)]);
    expect((await entry.redeem.call(world, older)).status).toBe(410);
    expect((await entry.redeem.call(world, newer)).status).toBe(entry.redeem.success);
  });
});

// The link of a message is built by the template from the deployment's origin and the one token it is handed
// (packages/email pins the fragment, `/…#token=…`, in each of the four templates, in both parts). What the server
// side owes that guarantee is below: the mail port is handed the bare token and no URL, a redemption takes the token
// in a JSON body, a token in a query string redeems nothing, and no log line, queued payload, error report or
// response holds the token, so there is no place from which a Referer could take one.
describe("where an emailed token travels", { timeout: TEST_TIMEOUT_MS }, () => {
  const REFERRER_POLICIES = /^(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin|origin)$/;

  it.each(caseTable)("%s: reaches the mail port as the bare token, and is in no queue, log, error report or response", async (_name, entry) => {
    const world = serve();
    const { account, ask } = await entry.prepare(world);
    await ask();
    const token = newestToken(entry.template);
    const message = mail.sent.filter((candidate) => candidate.template === entry.template).at(-1);
    for (const [key, value] of Object.entries(message?.data ?? {})) {
      expect(String(value), key).not.toMatch(/[:/?#=]/);
    }
    expect(Object.values(message?.data ?? {})).toContain(token);

    const redeemed = await entry.redeem.call(world, token);

    expect(redeemed.status).toBe(entry.redeem.success);
    expect(redeemed.headers.get("referrer-policy")).toMatch(REFERRER_POLICIES);
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    const everything = JSON.stringify([
      await database().app`SELECT * FROM pgboss.job`,
      world.logs.entries,
      world.logs.requests,
      workerLogs.entries,
      workerLogs.requests,
      captured,
      [...redeemed.headers],
      await redeemed.text(),
      account.email,
    ]);
    expect(everything).not.toContain(token);
    expect(world.logs.requests.map((line) => line.fields["route"])).toContain(entry.redeem.path);
  });

  it.each(caseTable)("%s: redeems nothing when sent in a query string, and the token stays good", async (_name, entry) => {
    const world = serve();
    const { account, ask } = await entry.prepare(world);
    await ask();
    const token = newestToken(entry.template);

    for (const method of ["GET", "POST"]) {
      const request = new Request(new URL(`${entry.redeem.path}?token=${token}`, world.origin), {
        method,
        headers: { origin: world.origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      const response = await world.server.fetch(request);
      expect([404, 405, 422], method).toContain(response.status);
    }

    expect((await tokenRows(account.id)).filter((row) => row.used_at !== null)).toEqual([]);
    expect(JSON.stringify([world.logs.entries, world.logs.requests])).not.toContain(token);
    expect((await entry.redeem.call(world, token)).status).toBe(entry.redeem.success);
  });
});
