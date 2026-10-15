import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenRepository, createAuthStore, type AuthStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// sys_api_token_lookup (doc 05 section 3.3, doc 04 section 4.2, doc 10 T4 and
// T18): the one way a bearer token reaches the database. The failure scenarios:
// a token that keeps working after it is revoked, expired, its account disabled,
// its workspace deleted or its membership ended; an answer that tells those cases
// apart; and a last-used write that happens on every request or that the
// application role can make itself.

const HOOK_TIMEOUT_MS = 300_000;
const MINUTE_MS = 60_000;

let db: TestDatabase;
let store: AuthStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: 4 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

interface Holder {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly tokenId: string;
  readonly hash: Buffer;
}

/** An account that is a member of a workspace of its own and holds one token bound to it. */
async function holder(scope: "read" | "read-write" = "read", expiresInDays: number | null = 90): Promise<Holder> {
  emailNumber += 1;
  const accountId = freshId();
  await seedAccount(db, { id: accountId, email: `lookup${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  const workspaceId = await seedWorkspace(db, { createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  const secret = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(`slb_${secret}`).digest();
  const tokenId = freshId();
  const outcome = await db.tenant.withTenant({ accountId, requestId: "lookup-test" }, (tx) =>
    apiTokenRepository(tx).create({ id: tokenId, workspaceId, name: "CI", scope, tokenHash: hash, tokenPrefix: secret.slice(0, 6), expiresInDays, limit: 10 }),
  );
  expect(outcome.kind).toBe("created");
  return { accountId, workspaceId, tokenId, hash };
}

interface Usage {
  last_used_at: Date | null;
  last_used_ip_prefix: string | null;
}

async function usage(tokenId: string): Promise<Usage> {
  const rows = await asSystem(db, (tx) => tx<Usage[]>`SELECT last_used_at, last_used_ip_prefix::text AS last_used_ip_prefix FROM api_tokens WHERE id = ${tokenId}`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such token");
  }
  return row;
}

async function backdateLastUse(tokenId: string, ms: number): Promise<void> {
  await asSystem(db, (tx) => tx`UPDATE api_tokens SET last_used_at = last_used_at - make_interval(secs => ${ms / 1000}) WHERE id = ${tokenId}`);
}

describe("sys_api_token_lookup", () => {
  it("is a registered system operation", () => {
    expect(systemOperations).toContain("sys_api_token_lookup");
  });

  it("answers the account, the bound workspace, the scope and the token for a valid token", async () => {
    const read = await holder("read");
    const write = await holder("read-write");
    expect(await store.lookupApiToken(read.hash, null)).toEqual({ tokenId: read.tokenId, accountId: read.accountId, workspaceId: read.workspaceId, scope: "read" });
    expect(await store.lookupApiToken(write.hash, null)).toEqual({ tokenId: write.tokenId, accountId: write.accountId, workspaceId: write.workspaceId, scope: "read-write" });
  });

  it("answers a token without an expiry", async () => {
    const forever = await holder("read", null);
    expect((await store.lookupApiToken(forever.hash, null))?.tokenId).toBe(forever.tokenId);
  });

  it("answers nothing for a hash that was never issued, and rejects one that is not 32 bytes", async () => {
    expect(await store.lookupApiToken(createHash("sha256").update("slb_never").digest(), null)).toBeUndefined();
    await expect(store.lookupApiToken(Buffer.alloc(31), null)).rejects.toThrow(RangeError);
  });

  it("answers nothing for a revoked token, and writes no last-used time for it", async () => {
    const revoked = await holder();
    expect(await db.tenant.withTenant({ accountId: revoked.accountId, requestId: "lookup-test" }, (tx) => apiTokenRepository(tx).revoke(revoked.tokenId))).toBe(true);
    expect(await store.lookupApiToken(revoked.hash, "203.0.0.0/16")).toBeUndefined();
    expect(await usage(revoked.tokenId)).toEqual({ last_used_at: null, last_used_ip_prefix: null });
  });

  it("answers nothing for an expired token", async () => {
    const expired = await holder();
    await asSystem(db, (tx) => tx`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${expired.tokenId}`);
    expect(await store.lookupApiToken(expired.hash, null)).toBeUndefined();
    expect((await usage(expired.tokenId)).last_used_at).toBeNull();
  });

  it("answers nothing for a token of a disabled account", async () => {
    const disabled = await holder();
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled.accountId}`);
    expect(await store.lookupApiToken(disabled.hash, null)).toBeUndefined();
  });

  it("answers nothing for a token bound to a workspace that is being deleted", async () => {
    const dying = await holder();
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${dying.workspaceId}`);
    expect(await store.lookupApiToken(dying.hash, null)).toBeUndefined();
  });

  it("answers nothing once the membership ended, which deletes the token with it", async () => {
    const left = await holder();
    expect((await store.lookupApiToken(left.hash, null))?.tokenId).toBe(left.tokenId);
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${left.workspaceId} AND account_id = ${left.accountId}`);
    expect(await store.lookupApiToken(left.hash, null)).toBeUndefined();
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM api_tokens WHERE id = ${left.tokenId}`)).toHaveLength(0);
  });

  it("writes the last-used time and the prefix on the first use, and not again within a minute", async () => {
    const used = await holder();
    const before = Date.now();
    await store.lookupApiToken(used.hash, "203.0.0.0/16");
    const first = await usage(used.tokenId);
    expect(first.last_used_ip_prefix).toBe("203.0.0.0/16");
    expect(Math.abs((first.last_used_at?.getTime() ?? 0) - before)).toBeLessThan(MINUTE_MS);

    await store.lookupApiToken(used.hash, "198.51.0.0/16");
    expect(await usage(used.tokenId)).toEqual(first);
  });

  it("writes again once the last use is more than a minute old, with the new prefix", async () => {
    const used = await holder();
    await store.lookupApiToken(used.hash, "203.0.0.0/16");
    await backdateLastUse(used.tokenId, MINUTE_MS + 5_000);
    const stale = await usage(used.tokenId);
    await store.lookupApiToken(used.hash, "2001:db8:1::/48");
    const again = await usage(used.tokenId);
    expect(again.last_used_ip_prefix).toBe("2001:db8:1::/48");
    expect((again.last_used_at?.getTime() ?? 0) - (stale.last_used_at?.getTime() ?? 0)).toBeGreaterThan(MINUTE_MS);

    await backdateLastUse(used.tokenId, MINUTE_MS + 5_000);
    await store.lookupApiToken(used.hash, null);
    expect((await usage(used.tokenId)).last_used_ip_prefix).toBeNull();
  });

  it("leaves the last use alone just inside the minute", async () => {
    const used = await holder();
    await store.lookupApiToken(used.hash, "203.0.0.0/16");
    await backdateLastUse(used.tokenId, MINUTE_MS - 10_000);
    const recent = await usage(used.tokenId);
    await store.lookupApiToken(used.hash, "198.51.0.0/16");
    expect(await usage(used.tokenId)).toEqual(recent);
  });

  it("answers every request of a burst of lookups at once and keeps the last use of the first writer within the minute", async () => {
    const used = await holder();
    const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => store.lookupApiToken(used.hash, `203.0.${String(index)}.0/24`)));
    expect(answers.every((answer) => answer?.tokenId === used.tokenId)).toBe(true);
    const after = await usage(used.tokenId);
    expect(after.last_used_at).not.toBeNull();
    // The first writer wins; a later one in the same minute finds the time fresh and leaves it.
    await store.lookupApiToken(used.hash, "198.51.0.0/16");
    expect(await usage(used.tokenId)).toEqual(after);
  });

  it("leaves last_used_at and the prefix to the lookup: the application role cannot write them, and cannot read the hash", async () => {
    const used = await holder();
    await expect(db.app`UPDATE api_tokens SET last_used_at = now() WHERE id = ${used.tokenId}`).rejects.toMatchObject({ code: "42501" });
    await expect(db.app`UPDATE api_tokens SET last_used_ip_prefix = '10.0.0.0/8' WHERE id = ${used.tokenId}`).rejects.toMatchObject({ code: "42501" });
    await expect(db.app`SELECT token_hash FROM api_tokens`).rejects.toMatchObject({ code: "42501" });
  });
});
