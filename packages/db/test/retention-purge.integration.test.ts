import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRetentionStore, type RetentionStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Retention (doc 05 section 6): sys_retention_purge() deletes what has outlived
// its retention, a batch of 5 000 rows per table per call, and answers how many
// it deleted per table. The rules so far: expired sessions, API tokens that
// were revoked or expired more than 30 days ago, OIDC login states past their expiry, credential
// tokens that were used or expired more than 7 days ago, and workspace audit events older than the
// retention the operator chose (365 days unless told otherwise, 0 keeps them forever).

const HOOK_TIMEOUT_MS = 300_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BATCH = 5_000;
const TOKEN_RETENTION_DAYS = 30;
const CREDENTIAL_TOKEN_RETENTION_DAYS = 7;
const FUNCTION = "public.sys_retention_purge(integer)";
const PREVIOUS_FUNCTION = "public.sys_retention_purge()";
const AUDIT_RETENTION_DAYS = 365;

let db: TestDatabase;
let store: RetentionStore;

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
  store = createRetentionStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `retention${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface SeedSession {
  readonly accountId: string;
  /** Offsets from now in milliseconds; negative is in the past. */
  readonly expiresIn: number;
  readonly absoluteExpiresIn: number;
  readonly level?: "partial" | "full";
}

async function seedSession(session: SeedSession): Promise<string> {
  const id = freshId();
  const { hash } = freshToken();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at)
      VALUES (${id}, ${hash}, ${session.accountId}, ${session.level ?? "full"}, false,
              now() - interval '200 days', now() - interval '1 day',
              now() + ${session.expiresIn} * interval '1 millisecond',
              now() + ${session.absoluteExpiresIn} * interval '1 millisecond')`;
  });
  return id;
}

/** What a purge answers when it deleted `sessions` sessions, `apiTokens` API tokens, `loginStates` OIDC login states, `credentialTokens` credential tokens, `auditEvents` audit events and `idempotencyKeys` idempotency keys, in the order of doc 05 section 6. */
function counts(sessions: number, apiTokens = 0, loginStates = 0, credentialTokens = 0, auditEvents = 0, idempotencyKeys = 0): { table: string; deleted: number }[] {
  return [
    { table: "sessions", deleted: sessions },
    { table: "api_tokens", deleted: apiTokens },
    { table: "oidc_login_states", deleted: loginStates },
    { table: "credential_tokens", deleted: credentialTokens },
    { table: "idempotency_keys", deleted: idempotencyKeys },
    { table: "audit_events", deleted: auditEvents },
  ];
}

async function remainingIds(): Promise<string[]> {
  return (await sessionRows(db)).map((row) => row.id).sort();
}

async function clearSessions(): Promise<void> {
  await asSystem(db, (tx) => tx`DELETE FROM sessions`);
}

describe("purging expired sessions", () => {
  it("deletes sessions past their sliding or absolute expiry, keeps the live ones, and counts what it deleted", async () => {
    await clearSessions();
    const mine = await account();
    const other = await account();
    await seedSession({ accountId: mine, expiresIn: -HOUR_MS, absoluteExpiresIn: 100 * DAY_MS });
    await seedSession({ accountId: mine, expiresIn: 10 * DAY_MS, absoluteExpiresIn: -HOUR_MS });
    await seedSession({ accountId: other, expiresIn: -2 * DAY_MS, absoluteExpiresIn: -DAY_MS });
    await seedSession({ accountId: other, expiresIn: -1000, absoluteExpiresIn: DAY_MS, level: "partial" });
    const live = await seedSession({ accountId: mine, expiresIn: 10 * DAY_MS, absoluteExpiresIn: 100 * DAY_MS });
    const otherLive = await seedSession({ accountId: other, expiresIn: HOUR_MS, absoluteExpiresIn: 100 * DAY_MS });
    const justLive = await seedSession({ accountId: other, expiresIn: 60_000, absoluteExpiresIn: 60_000 });

    const purged = await store.purge();

    expect(purged).toEqual(counts(4));
    expect(await remainingIds()).toEqual([live, otherLive, justLive].sort());
  });

  it("deletes nothing and says so when no session has expired", async () => {
    await clearSessions();
    const owner = await account();
    const live = await seedSession({ accountId: owner, expiresIn: DAY_MS, absoluteExpiresIn: DAY_MS });

    expect(await store.purge()).toEqual(counts(0));
    expect(await remainingIds()).toEqual([live]);
  });

  it("leaves the accounts alone", async () => {
    await clearSessions();
    const owner = await account();
    await seedSession({ accountId: owner, expiresIn: -HOUR_MS, absoluteExpiresIn: -HOUR_MS });
    const before = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts`;

    await store.purge();

    const after = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts`;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it("deletes one batch of 5 000 per call and finishes the rest on the next calls", async () => {
    await clearSessions();
    const owner = await account();
    const live = await seedSession({ accountId: owner, expiresIn: DAY_MS, absoluteExpiresIn: DAY_MS });
    const extra = 123;
    await asSystem(db, async (tx) => {
      await tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at)
        SELECT gen_random_uuid(), decode(md5('a' || n::text) || md5('b' || n::text), 'hex'), ${owner}, 'full', false,
               now() - interval '200 days', now() - interval '1 day',
               now() - interval '1 hour', now() + interval '10 days'
        FROM generate_series(1, ${2 * BATCH + extra}) AS n`;
    });

    expect(await store.purge()).toEqual(counts(BATCH));
    expect((await sessionRows(db)).length).toBe(BATCH + extra + 1);
    expect(await store.purge()).toEqual(counts(BATCH));
    expect(await store.purge()).toEqual(counts(extra));
    expect(await store.purge()).toEqual(counts(0));
    expect(await remainingIds()).toEqual([live]);
  }, HOOK_TIMEOUT_MS);

  it("does not wait for a session a concurrent request holds and deletes it on a later call", async () => {
    await clearSessions();
    const owner = await account();
    const locked = await seedSession({ accountId: owner, expiresIn: -HOUR_MS, absoluteExpiresIn: DAY_MS });
    await seedSession({ accountId: owner, expiresIn: -HOUR_MS, absoluteExpiresIn: DAY_MS });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = asSystem(db, async (tx) => {
      await tx`SELECT id FROM sessions WHERE id = ${locked} FOR UPDATE`;
      acquired();
      await held;
    });
    await lockTaken;

    const purged = await store.purge();
    release();
    await holder;

    expect(purged).toEqual(counts(1));
    expect(await remainingIds()).toEqual([locked]);
    expect(await store.purge()).toEqual(counts(1));
    expect(await remainingIds()).toEqual([]);
  });
});

interface Holder {
  readonly accountId: string;
  readonly workspaceId: string;
}

/** An account that is a member of a workspace of its own, which is what an API token needs to be bound to. */
async function holder(): Promise<Holder> {
  const accountId = await account();
  const workspaceId = await seedWorkspace(db, { createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  return { accountId, workspaceId };
}

interface SeedToken {
  readonly holder: Holder;
  /** Offsets from now in days; negative is in the past, null leaves the column empty. */
  readonly revokedIn: number | null;
  readonly expiresIn: number | null;
}

/**
 * Seeds rows with the offsets a test needs, which the application never writes (a revocation
 * date in the past, a creation date). slugbase_system holds no INSERT on api_tokens, so the table
 * owner inserts, in the account-level setting of the row's account, so the policy admits it.
 */
async function asOwner(accountId: string, work: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await work(tx);
  });
}

async function seedToken(token: SeedToken): Promise<string> {
  const id = freshId();
  const { hash } = freshToken();
  await asOwner(token.holder.accountId, async (tx) => {
    await tx`
      INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope, expires_at, revoked_at, created_at)
      VALUES (${id}, ${token.holder.accountId}, ${token.holder.workspaceId}, ${id}, ${hash}, 'abcdef', 'read',
              now() + ${token.expiresIn} * interval '1 day', now() + ${token.revokedIn} * interval '1 day',
              now() - interval '400 days')`;
  });
  return id;
}

async function tokenIds(): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM api_tokens`);
  return rows.map((row) => row.id).sort();
}

async function clearApiTokens(): Promise<void> {
  await asSystem(db, (tx) => tx`DELETE FROM api_tokens`);
}

describe("purging revoked and expired API tokens", () => {
  beforeEach(async () => {
    await clearApiTokens();
  });

  it("deletes a token revoked or expired more than 30 days ago and keeps the rest", async () => {
    const owner = await holder();
    const other = await holder();
    const over = TOKEN_RETENTION_DAYS + 1;
    const under = TOKEN_RETENTION_DAYS - 1;
    // Past retention: revoked, expired, and both; whatever the other column says.
    await seedToken({ holder: owner, revokedIn: -over, expiresIn: 60 });
    await seedToken({ holder: owner, revokedIn: -over, expiresIn: null });
    await seedToken({ holder: owner, revokedIn: null, expiresIn: -over });
    await seedToken({ holder: other, revokedIn: -over, expiresIn: -over });
    await seedToken({ holder: other, revokedIn: -under, expiresIn: -over });
    await seedToken({ holder: other, revokedIn: -1, expiresIn: -over });
    // Kept: inside the 30 days, active, and without an expiry.
    const revokedRecently = await seedToken({ holder: owner, revokedIn: -under, expiresIn: 60 });
    const expiredRecently = await seedToken({ holder: other, revokedIn: null, expiresIn: -under });
    const bothRecently = await seedToken({ holder: other, revokedIn: -1, expiresIn: -under });
    const active = await seedToken({ holder: owner, revokedIn: null, expiresIn: 60 });
    const forever = await seedToken({ holder: other, revokedIn: null, expiresIn: null });
    const expiresSoon = await seedToken({ holder: other, revokedIn: null, expiresIn: 0.001 });

    const purged = await store.purge();

    expect(purged).toEqual(counts(0, 6));
    expect(await tokenIds()).toEqual([revokedRecently, expiredRecently, bothRecently, active, forever, expiresSoon].sort());
  });

  it("deletes nothing and says so when no token is past its retention", async () => {
    const owner = await holder();
    const active = await seedToken({ holder: owner, revokedIn: null, expiresIn: 90 });
    const revoked = await seedToken({ holder: owner, revokedIn: -2, expiresIn: 90 });

    expect(await store.purge()).toEqual(counts(0, 0));
    expect(await tokenIds()).toEqual([active, revoked].sort());
  });

  it("leaves the accounts, the memberships and the workspaces alone", async () => {
    const owner = await holder();
    await seedToken({ holder: owner, revokedIn: -TOKEN_RETENTION_DAYS - 1, expiresIn: null });
    const count = async () =>
      (await db.owner<{ accounts: number; members: number; workspaces: number }[]>`
        SELECT (SELECT count(*) FROM accounts)::int AS accounts,
               (SELECT count(*) FROM workspace_members)::int AS members,
               (SELECT count(*) FROM workspaces)::int AS workspaces`)[0];
    const before = await count();

    expect(await store.purge()).toEqual(counts(0, 1));

    expect(await count()).toEqual(before);
  });

  it("deletes one batch of 5 000 per call and finishes the rest on the next calls", async () => {
    const owner = await holder();
    const live = await seedToken({ holder: owner, revokedIn: null, expiresIn: 90 });
    const extra = 123;
    await asOwner(owner.accountId, async (tx) => {
      await tx`
        INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope, expires_at, revoked_at, created_at)
        SELECT gen_random_uuid(), ${owner.accountId}, ${owner.workspaceId}, 'n' || n::text,
               decode(md5('a' || n::text) || md5('b' || n::text), 'hex'), 'abcdef', 'read',
               now() + interval '10 days', now() - interval '31 days', now() - interval '400 days'
        FROM generate_series(1, ${2 * BATCH + extra}) AS n`;
    });

    expect(await store.purge()).toEqual(counts(0, BATCH));
    expect((await tokenIds()).length).toBe(BATCH + extra + 1);
    expect(await store.purge()).toEqual(counts(0, BATCH));
    expect(await store.purge()).toEqual(counts(0, extra));
    expect(await store.purge()).toEqual(counts(0, 0));
    expect(await tokenIds()).toEqual([live]);
  }, HOOK_TIMEOUT_MS);

  it("does not wait for a token a concurrent statement holds and deletes it on a later call", async () => {
    const owner = await holder();
    const locked = await seedToken({ holder: owner, revokedIn: -TOKEN_RETENTION_DAYS - 1, expiresIn: null });
    await seedToken({ holder: owner, revokedIn: -TOKEN_RETENTION_DAYS - 1, expiresIn: null });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = asSystem(db, async (tx) => {
      await tx`SELECT id FROM api_tokens WHERE id = ${locked} FOR UPDATE`;
      acquired();
      await held;
    });
    await lockTaken;

    const purged = await store.purge();
    release();
    await holding;

    expect(purged).toEqual(counts(0, 1));
    expect(await tokenIds()).toEqual([locked]);
    expect(await store.purge()).toEqual(counts(0, 1));
    expect(await tokenIds()).toEqual([]);
  });

  it("gives slugbase_app no DELETE on api_tokens: the purge is the only way it removes one", async () => {
    await expect(db.app.unsafe("DELETE FROM public.api_tokens")).rejects.toMatchObject({ code: "42501" });
    const rows = await db.owner<{ app: boolean; system: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'public.api_tokens', 'DELETE') AS app,
             has_table_privilege('slugbase_system', 'public.api_tokens', 'DELETE') AS system`;
    expect([...rows]).toEqual([{ app: false, system: true }]);
  });
});

describe("purging expired OIDC login states", () => {
  async function seedState(expiresIn: number): Promise<Buffer> {
    const { hash } = freshToken();
    await asSystem(db, (tx) => tx`
      INSERT INTO oidc_login_states (state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, expires_at)
      VALUES (${hash}, 'idp', 'login', 'nonce', ${Buffer.alloc(40, 1)}, 'k1', '/', now() + ${expiresIn} * interval '1 millisecond')`);
    return hash;
  }

  async function remainingStates(): Promise<string[]> {
    const rows = await asSystem(db, (tx) => tx<{ state_hash: Buffer }[]>`SELECT state_hash FROM oidc_login_states`);
    return rows.map((row) => row.state_hash.toString("hex")).sort();
  }

  it("deletes a state past its expiry, keeps the live ones, and counts what it deleted", async () => {
    await clearSessions();
    await asSystem(db, (tx) => tx`DELETE FROM oidc_login_states`);
    await seedState(-HOUR_MS);
    await seedState(-1000);
    const live = await seedState(60_000);

    expect(await store.purge()).toEqual(counts(0, 0, 2));
    expect(await remainingStates()).toEqual([live.toString("hex")]);
    expect(await store.purge()).toEqual(counts(0, 0, 0));
  });

  it("gives slugbase_app no DELETE on oidc_login_states: the purge and the consume are the only ways a state is removed", async () => {
    await expect(db.app.unsafe("DELETE FROM public.oidc_login_states")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("purging used and expired credential tokens", () => {
  interface SeedCredentialToken {
    /** Offsets from now in milliseconds; negative is in the past. */
    readonly expiresIn: number;
    readonly usedIn?: number;
  }

  async function seedCredentialToken(owner: string, token: SeedCredentialToken): Promise<string> {
    const id = freshId();
    const { hash } = freshToken();
    await asSystem(db, (tx) => tx`
      INSERT INTO credential_tokens (id, purpose, account_id, token_hash, expires_at, used_at)
      VALUES (${id}, 'email_verify', ${owner}, ${hash}, now() + ${token.expiresIn} * interval '1 millisecond',
              now() + ${token.usedIn ?? null}::bigint * interval '1 millisecond')`);
    return id;
  }

  async function remainingCredentialTokens(): Promise<string[]> {
    const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM credential_tokens`);
    return rows.map((row) => row.id).sort();
  }

  async function clearCredentialTokens(): Promise<void> {
    await asSystem(db, (tx) => tx`DELETE FROM credential_tokens`);
  }

  it("deletes a token used or expired more than 7 days ago and keeps every other, counting what it deleted", async () => {
    await clearSessions();
    await clearCredentialTokens();
    const owner = await account();
    const past = CREDENTIAL_TOKEN_RETENTION_DAYS * DAY_MS;
    const gone = [
      await seedCredentialToken(owner, { expiresIn: -past - HOUR_MS }),
      await seedCredentialToken(owner, { expiresIn: DAY_MS, usedIn: -past - HOUR_MS }),
      await seedCredentialToken(owner, { expiresIn: -past - HOUR_MS, usedIn: -past - 2 * HOUR_MS }),
    ];
    const kept = [
      await seedCredentialToken(owner, { expiresIn: DAY_MS }),
      await seedCredentialToken(owner, { expiresIn: -past + HOUR_MS }),
      await seedCredentialToken(owner, { expiresIn: DAY_MS, usedIn: -past + HOUR_MS }),
    ];

    expect(await store.purge()).toEqual(counts(0, 0, 0, gone.length));
    expect(await remainingCredentialTokens()).toEqual(kept.sort());
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0));
  });

  it("deletes at most one batch per call and finishes the rest on the next", async () => {
    await clearCredentialTokens();
    const owner = await account();
    const extra = 3;
    await asSystem(db, async (tx) => {
      await tx`
        INSERT INTO credential_tokens (id, purpose, account_id, token_hash, expires_at)
        SELECT ('0192f3a0-dddd-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'email_verify', ${owner},
               sha256(('batch' || n)::bytea), now() - interval '8 days'
        FROM generate_series(1, ${BATCH + extra}::int) AS n`;
    });

    expect(await store.purge()).toEqual(counts(0, 0, 0, BATCH));
    expect(await store.purge()).toEqual(counts(0, 0, 0, extra));
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0));
  });

  it("gives slugbase_app no DELETE on credential_tokens: the purge is the only way it removes one", async () => {
    await expect(db.app.unsafe("DELETE FROM public.credential_tokens")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("purging expired idempotency keys", () => {
  /** Seeds a key that expires `expiresIn` milliseconds from now (negative is in the past), through the application role as the account. */
  async function seedKey(owner: string, expiresIn: number): Promise<string> {
    const key = freshId();
    await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${owner}, true)`;
      await tx`
        INSERT INTO idempotency_keys (account_id, key, operation, request_hash, expires_at)
        VALUES (${owner}, ${key}, 'createInvitation', ${Buffer.alloc(32)}, now() + ${expiresIn} * interval '1 millisecond')`;
    });
    return key;
  }

  async function remainingKeys(): Promise<string[]> {
    const rows = await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ key: string }[]>`SELECT key FROM idempotency_keys`;
    });
    return rows.map((row) => row.key).sort();
  }

  async function clearKeys(): Promise<void> {
    await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`DELETE FROM idempotency_keys`;
    });
  }

  it("deletes a key 24 hours after it was first used and keeps a younger one, counting what it deleted", async () => {
    await clearSessions();
    await clearKeys();
    const owner = await account();
    const other = await account();
    // A key lives 24 hours from its first use: one made 25 hours ago has expired, one made 23 hours ago has not.
    const gone = [await seedKey(owner, -HOUR_MS), await seedKey(other, -DAY_MS)];
    const kept = [await seedKey(owner, HOUR_MS), await seedKey(other, DAY_MS - HOUR_MS)];

    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0, gone.length));
    expect(await remainingKeys()).toEqual(kept.sort());
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0, 0));
  });

  it("deletes at most one batch per call and finishes the rest on the next", async () => {
    await clearKeys();
    const owner = await account();
    const extra = 3;
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${owner}, true)`;
      await tx`
        INSERT INTO idempotency_keys (account_id, key, operation, request_hash, expires_at)
        SELECT ${owner}, ('0192f3a0-eeee-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'createInvitation', sha256(('batch' || n)::bytea),
               now() - interval '1 hour'
        FROM generate_series(1, ${BATCH + extra}::int) AS n`;
    });

    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0, BATCH));
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0, extra));
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0, 0));
  });

  it("gives slugbase_app no DELETE on idempotency_keys: the purge is the only way it removes one", async () => {
    await expect(db.app.unsafe("DELETE FROM public.idempotency_keys")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("purging audit events", () => {
  let workspaceId: string;

  interface SeedAuditEvent {
    /** How many days ago the event was recorded. */
    readonly ageDays: number;
    /** Left null for a deployment-level event, which has no workspace. */
    readonly workspace?: string | null;
  }

  async function seedAuditEvent(event: SeedAuditEvent): Promise<string> {
    const id = freshId();
    const target = event.workspace === undefined ? workspaceId : event.workspace;
    await asSystem(db, (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata, created_at)
      VALUES (${id}, ${target}, 'system', 'SlugBase', 'workspace.created', '{}'::jsonb, now() - ${event.ageDays} * interval '1 day')`);
    return id;
  }

  async function remainingAuditEvents(): Promise<string[]> {
    const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM audit_events`);
    return rows.map((row) => row.id).sort();
  }

  async function clearAuditEvents(): Promise<void> {
    await clearSessions();
    await asSystem(db, (tx) => tx`DELETE FROM audit_events`);
  }

  beforeAll(async () => {
    workspaceId = await seedWorkspace(db, { name: "Audited" });
  }, HOOK_TIMEOUT_MS);

  it("deletes the events older than the retention and keeps the newer ones, counting what it deleted", async () => {
    await clearAuditEvents();
    await seedAuditEvent({ ageDays: AUDIT_RETENTION_DAYS + 30 });
    await seedAuditEvent({ ageDays: AUDIT_RETENTION_DAYS + 1 });
    const recent = await seedAuditEvent({ ageDays: AUDIT_RETENTION_DAYS - 1 });
    const fresh = await seedAuditEvent({ ageDays: 0 });

    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 2));

    expect(await remainingAuditEvents()).toEqual([recent, fresh].sort());
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0));
  });

  it("deletes the events of every workspace", async () => {
    await clearAuditEvents();
    const other = await seedWorkspace(db, { name: "Other audited" });
    await seedAuditEvent({ ageDays: 400 });
    await seedAuditEvent({ ageDays: 400, workspace: other });

    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 2));
    expect(await remainingAuditEvents()).toEqual([]);
  });

  it("keeps an event with no workspace, which is a deployment-level one", async () => {
    await clearAuditEvents();
    const deployment = await seedAuditEvent({ ageDays: 1000, workspace: null });

    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0));
    expect(await remainingAuditEvents()).toEqual([deployment]);
  });

  it("uses the retention the store was opened with: a shorter one deletes more, 0 deletes none", async () => {
    await clearAuditEvents();
    const month = await seedAuditEvent({ ageDays: 40 });
    const old = await seedAuditEvent({ ageDays: 400 });

    const forever = createRetentionStore({ url: appUrl(db), poolSize: 1, auditRetentionDays: 0 });
    const monthly = createRetentionStore({ url: appUrl(db), poolSize: 1, auditRetentionDays: 30 });
    try {
      expect(await forever.purge()).toEqual(counts(0, 0, 0, 0, 0));
      expect(await remainingAuditEvents()).toEqual([month, old].sort());
      expect(await monthly.purge()).toEqual(counts(0, 0, 0, 0, 2));
      expect(await remainingAuditEvents()).toEqual([]);
    } finally {
      await forever.close();
      await monthly.close();
    }
  });

  it("deletes one batch of 5 000 per call and finishes the rest on the next calls", async () => {
    await clearAuditEvents();
    const extra = 7;
    await asSystem(db, (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata, created_at)
      SELECT gen_random_uuid(), ${workspaceId}, 'system', 'SlugBase', 'workspace.created', '{}'::jsonb, now() - interval '400 days'
      FROM generate_series(1, ${BATCH + extra})`);

    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, BATCH));
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, extra));
    expect(await store.purge()).toEqual(counts(0, 0, 0, 0, 0));
  });

  it("refuses a negative retention and a missing one, and deletes nothing", async () => {
    await clearAuditEvents();
    const old = await seedAuditEvent({ ageDays: 400 });

    await expect(db.app`SELECT * FROM sys_retention_purge(-1)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT * FROM sys_retention_purge(NULL::integer)`).rejects.toMatchObject({ code: "22023" });

    expect(await remainingAuditEvents()).toEqual([old]);
  });

  it("is not reachable by slugbase_app except through the purge: it can neither update nor delete an event", async () => {
    await expect(db.app.unsafe("DELETE FROM public.audit_events")).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe("UPDATE public.audit_events SET action = 'x'")).rejects.toMatchObject({ code: "42501" });
    const rows = await db.owner<{ app: boolean; system: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'public.audit_events', 'DELETE') AS app,
             has_table_privilege('slugbase_system', 'public.audit_events', 'DELETE') AS system`;
    expect([...rows]).toEqual([{ app: false, system: true }]);
  });

  it("is left alone by the overload of the previous release, which keeps the audit log whatever its age", async () => {
    await clearAuditEvents();
    const old = await seedAuditEvent({ ageDays: 4000 });

    const rows = await db.app<{ table_name: string; deleted: string }[]>`SELECT table_name, deleted::text AS deleted FROM sys_retention_purge()`;

    expect(rows.map((row) => ({ table: row.table_name, deleted: Number(row.deleted) }))).toEqual(counts(0));
    expect(await remainingAuditEvents()).toEqual([old]);
  });
});

describe("sys_retention_purge()", () => {
  const SIGNATURES = [FUNCTION, PREVIOUS_FUNCTION] as const;

  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path, in the registry, in each overload", async () => {
    for (const signature of SIGNATURES) {
      const rows = await db.owner<{ definer: boolean; owner: string; config: string[]; language: string }[]>`
        SELECT prosecdef AS definer, pg_get_userbyid(proowner) AS owner, proconfig AS config, l.lanname AS language
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.oid = ${signature}::regprocedure`;
      expect([...rows]).toEqual([
        { definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], language: "plpgsql" },
      ]);
    }
    expect(systemOperations).toContain("sys_retention_purge");
  });

  it("lets slugbase_app run it and nobody else but the owner, in each overload", async () => {
    for (const signature of SIGNATURES) {
      const rows = await db.owner<{ app: boolean; public: boolean }[]>`
        SELECT has_function_privilege('slugbase_app', ${signature}::regprocedure, 'EXECUTE') AS app,
               EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = ${signature}::regprocedure AND a.grantee = 0) AS public`;
      expect([...rows]).toEqual([{ app: true, public: false }]);
    }
  });

  it("takes one argument, which only chooses how long audit events stay", async () => {
    const rows = await db.owner<{ args: number; names: string[] }[]>`
      SELECT pronargs::int AS args, proargnames AS names FROM pg_proc WHERE oid = ${FUNCTION}::regprocedure`;
    expect([...rows]).toEqual([{ args: 1, names: ["p_audit_retention_days", "table_name", "deleted"] }]);
  });

  it("gives slugbase_app no privilege on sessions: the purge is the only way it removes one", async () => {
    await expect(db.app.unsafe("DELETE FROM public.sessions")).rejects.toMatchObject({ code: "42501" });
  });
});
