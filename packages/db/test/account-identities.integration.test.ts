import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentityRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { freshId, seedAccount } from "./support/auth-fixture.ts";

// The identities listed to the account that holds them (doc 05 section 2.1, doc 04 section 10.3, doc 10 T1 and
// T20): the repository over the own-account policy of `account_identities`. The failure scenarios: an account that
// lists another account's identities, and a column the application role should not read (the provider's subject).

const HOOK_TIMEOUT_MS = 300_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `identities${String(emailNumber)}@example.test`, passwordHash: null });
  return id;
}

async function link(accountId: string, subject: string, extra: { lastUsedAt?: Date } = {}): Promise<string> {
  const id = freshId();
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`
      INSERT INTO account_identities (id, account_id, provider, subject, email_at_link, last_used_at)
      VALUES (${id}, ${accountId}, 'idp', ${subject}, 'person@example.test', ${extra.lastUsedAt ?? null})`;
  });
  return id;
}

function list(accountId: string, afterId: string | null, limit: number) {
  return db.tenant.withTenant({ accountId, requestId: "identities-test" }, (tx) => accountIdentityRepository(tx).list(afterId, limit));
}

describe("accountIdentityRepository", () => {
  it("lists the account's identities, newest first, without the subject of the provider", async () => {
    const holder = await account();
    const first = await link(holder, "sub-a");
    const second = await link(holder, "sub-b", { lastUsedAt: new Date("2026-10-01T10:00:00Z") });

    const listed = await list(holder, null, 10);

    expect(listed.map((identity) => identity.id)).toEqual([second, first]);
    expect(listed[0]).toEqual({ id: second, provider: "idp", emailAtLink: "person@example.test", createdAt: expect.any(Date) as Date, lastUsedAt: new Date("2026-10-01T10:00:00Z") });
    expect(listed[1]?.lastUsedAt).toBeNull();
    expect(JSON.stringify(listed)).not.toContain("sub-");
  });

  it("lists the identities of its own account only: another account's are not listed, whatever position the page starts at", async () => {
    const mine = await account();
    const theirs = await account();
    const own = await link(mine, "sub-mine");
    const foreign = await link(theirs, "sub-theirs");

    expect((await list(mine, null, 10)).map((identity) => identity.id)).toEqual([own]);
    expect((await list(mine, foreign, 10)).map((identity) => identity.id)).toEqual([own]);
    expect((await list(theirs, null, 10)).map((identity) => identity.id)).toEqual([foreign]);
  });

  it("pages by the identifier of the last identity of the previous page", async () => {
    const holder = await account();
    const ids = [await link(holder, "p1"), await link(holder, "p2"), await link(holder, "p3")];

    const firstPage = await list(holder, null, 2);
    expect(firstPage.map((identity) => identity.id)).toEqual([ids[2], ids[1]]);
    const secondPage = await list(holder, firstPage[1]?.id ?? null, 2);
    expect(secondPage.map((identity) => identity.id)).toEqual([ids[0]]);
  });

  it("is limited by row-level security even without the application's predicate: the application role reads only its own account's rows, and no subject column", async () => {
    const mine = await account();
    const theirs = await account();
    await link(mine, "rls-mine");
    await link(theirs, "rls-theirs");

    const seen = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${mine}, true)`;
      return [...(await tx<{ account_id: string }[]>`SELECT account_id FROM account_identities`)];
    });
    expect(seen.every((row) => row.account_id === mine)).toBe(true);
    await expect(db.app.unsafe("SELECT subject FROM public.account_identities")).rejects.toMatchObject({ code: "42501" });
  });
});
