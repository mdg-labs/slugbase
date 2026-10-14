import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type NewSession } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// Accounts and sessions (doc 05 sections 2.1, 3.1 and 3.3, doc 10 T4 and T8):
// the tables nobody but slugbase_system can read around, the password hash the
// application role cannot select, and the four system operations that sign an
// account in, resolve a session cookie and end a session.

const HOOK_TIMEOUT_MS = 300_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

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
async function account(overrides: { email?: string; passwordHash?: string | null; disabledAt?: Date; passwordChangedAt?: Date; isInstanceAdmin?: boolean } = {}) {
  emailNumber += 1;
  const id = freshId();
  const email = overrides.email ?? `Person${String(emailNumber)}@Example.test`;
  await seedAccount(db, { id, passwordHash: "$argon2id$stub", ...overrides, email });
  return { id, email };
}

function newSession(accountId: string, overrides: Partial<NewSession> = {}): NewSession & { token: Buffer } {
  const { token, hash } = freshToken();
  return {
    id: freshId(),
    accountId,
    remember: false,
    ipPrefix: "203.0.0.0/16",
    userAgent: "Vitest",
    tokenHash: hash,
    replacedTokenHash: null,
    token,
    ...overrides,
  };
}

describe("the accounts table", () => {
  it("has the columns of doc 05 section 2.1 other than the multi-factor ones", async () => {
    const columns = await db.owner<{ name: string; type: string; nullable: boolean }[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
      FROM pg_attribute a
      WHERE a.attrelid = 'public.accounts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect(columns.map((column) => column.name)).toEqual([
      "id", "email", "email_verified_at", "pending_email", "display_name", "password_hash", "password_changed_at",
      "locale", "theme", "accent", "default_bookmark_view", "single_key_shortcuts", "signin_alerts", "ai_opt_out",
      "analytics_consent", "consent_at", "onboarding", "is_instance_admin", "disabled_at", "last_sign_in_at",
      "created_at", "updated_at",
    ]);
    const types = Object.fromEntries(columns.map((column) => [column.name, column.type]));
    expect(types["email"]).toBe("citext");
    expect(types["pending_email"]).toBe("citext");
    expect(types["password_hash"]).toBe("text");
    expect(types["id"]).toBe("uuid");
  });

  it("compares the email case-insensitively and refuses a second account for the same address", async () => {
    const first = await account();
    await expect(
      seedAccount(db, { id: freshId(), email: first.email.toLowerCase() }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("has row-level security enabled and forced, with the own-row policy", async () => {
    const rows = await db.owner<{ enabled: boolean; forced: boolean; policies: string[] }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             coalesce((SELECT array_agg(p.polname) FROM pg_policy p WHERE p.polrelid = c.oid), '{}') AS policies
      FROM pg_class c WHERE c.oid = 'public.accounts'::regclass`;
    expect([...rows]).toEqual([{ enabled: true, forced: true, policies: ["accounts_tenant"] }]);
  });

  it("shows slugbase_app only its own row", async () => {
    const mine = await account();
    const other = await account();
    const seen = await db.tenant.withTenant({ accountId: mine.id, requestId: "test-request" }, async () =>
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${mine.id}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM accounts WHERE id IN (${mine.id}, ${other.id})`;
      }),
    );
    expect(seen.map((row) => row.id)).toEqual([mine.id]);
    const outside = await db.app<{ id: string }[]>`SELECT id FROM accounts`;
    expect([...outside]).toEqual([]);
  });

  it("gives slugbase_app no way to read password_hash, with SELECT * included", async () => {
    const rows = await db.owner<{ column: string; app: boolean }[]>`
      SELECT a.attname AS column, has_column_privilege('slugbase_app', 'public.accounts', a.attname, 'SELECT') AS app
      FROM pg_attribute a
      WHERE a.attrelid = 'public.accounts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect(rows.filter((row) => !row.app).map((row) => row.column)).toEqual(["password_hash"]);
    await expect(db.app.unsafe("SELECT password_hash FROM public.accounts")).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe("SELECT * FROM public.accounts")).rejects.toMatchObject({ code: "42501" });
    const writes = await db.owner<{ privilege: string; app: boolean }[]>`
      SELECT p AS privilege, has_table_privilege('slugbase_app', 'public.accounts', p) AS app
      FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p`;
    expect(writes.filter((row) => row.app)).toEqual([]);
  });
});

describe("the sessions table", () => {
  it("has the columns, the 32-byte token hash and the indexes of doc 05 section 2.1", async () => {
    const columns = await db.owner<{ name: string; type: string }[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      WHERE a.attrelid = 'public.sessions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect(Object.fromEntries(columns.map((column) => [column.name, column.type]))).toEqual({
      id: "uuid",
      token_hash: "bytea",
      account_id: "uuid",
      level: "text",
      active_workspace_id: "uuid",
      reauth_at: "timestamp with time zone",
      remember: "boolean",
      created_at: "timestamp with time zone",
      last_seen_at: "timestamp with time zone",
      expires_at: "timestamp with time zone",
      absolute_expires_at: "timestamp with time zone",
      ip_prefix: "cidr",
      user_agent: "text",
    });
    const indexes = await db.owner<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes WHERE tablename = 'sessions' ORDER BY indexname`;
    expect(indexes.map((index) => index.name)).toEqual([
      "sessions_account_id_idx",
      "sessions_expires_at_idx",
      "sessions_pkey",
      "sessions_token_hash_key",
    ]);
  });

  it("has row-level security enabled and forced, and no policy", async () => {
    const rows = await db.owner<{ enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c WHERE c.oid = 'public.sessions'::regclass`;
    expect([...rows]).toEqual([{ enabled: true, forced: true, policies: 0 }]);
  });

  it("gives slugbase_app and PUBLIC no privilege on it, and keeps it unreadable to the table owner", async () => {
    const rows = await db.owner<{ privilege: string; app: boolean }[]>`
      SELECT p AS privilege, has_table_privilege('slugbase_app', 'public.sessions', p) AS app
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p`;
    expect(rows.filter((row) => row.app)).toEqual([]);
    const columnPrivileges = await db.owner<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_attribute a
      WHERE a.attrelid = 'public.sessions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.sessions', a.attname, 'SELECT')`;
    expect(columnPrivileges[0]?.count).toBe(0);
    const publicGrants = await db.owner<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = 'public.sessions'::regclass AND a.grantee = 0`;
    expect(publicGrants[0]?.count).toBe(0);
    await expect(db.app.unsafe("SELECT * FROM public.sessions")).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe("DELETE FROM public.sessions")).rejects.toMatchObject({ code: "42501" });
    expect([...(await db.owner<{ id: string }[]>`SELECT id FROM sessions`)]).toEqual([]);
  });
});

describe("the session system operations", () => {
  const operations = ["sys_login_lookup", "sys_session_create", "sys_session_lookup", "sys_session_revoke"];

  it("are SECURITY DEFINER functions of slugbase_system with a pinned search_path, callable by slugbase_app only, and in the registry", async () => {
    const rows = await db.owner<{ name: string; definer: boolean; owner: string; config: string[]; app: boolean; public: boolean }[]>`
      SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (${operations})
      ORDER BY p.proname`;
    expect(rows.map((row) => row.name)).toEqual(operations);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ definer: true, owner: "slugbase_system", app: true, public: false });
      expect(row.config, row.name).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(systemOperations, row.name).toContain(row.name);
    }
  });

  describe("emailKey", () => {
    it("is one string for the addresses the lookup treats as one account, including those JavaScript lower-cases differently", async () => {
      const person = await account({ email: "victim@example.test" });
      const spellings = ["victim@example.test", "VICTIM@Example.TEST", "vİctim@example.test", "vİctİm@example.test"];
      for (const spelling of spellings) {
        expect((await store.loginLookup(spelling))?.accountId, spelling).toBe(person.id);
        expect(await store.emailKey(spelling), spelling).toBe(await store.emailKey(person.email));
      }
      expect(await store.emailKey("other@example.test")).not.toBe(await store.emailKey(person.email));
    });
  });

  describe("sys_login_lookup", () => {
    it("finds the account by its email in any case and returns the password hash", async () => {
      const person = await account({ passwordHash: "$argon2id$v=19$stub" });
      const found = await store.loginLookup(person.email.toUpperCase());
      expect(found).toEqual({ accountId: person.id, passwordHash: "$argon2id$v=19$stub", disabledAt: null });
      expect((await store.loginLookup(person.email.toLowerCase()))?.accountId).toBe(person.id);
    });

    it("answers nothing for an address no account has, and reports a disabled account and a missing password", async () => {
      expect(await store.loginLookup("nobody@example.test")).toBeUndefined();
      const disabled = await account({ disabledAt: new Date("2026-01-01T00:00:00Z") });
      expect((await store.loginLookup(disabled.email))?.disabledAt).toEqual(new Date("2026-01-01T00:00:00Z"));
      const oidcOnly = await account({ passwordHash: null });
      expect((await store.loginLookup(oidcOnly.email))?.passwordHash).toBeNull();
    });
  });

  describe("sys_session_create", () => {
    it("stores only the token hash, the coarse prefix and a truncated user agent, with the 30-day window and the 180-day cap", async () => {
      const person = await account();
      const session = newSession(person.id, { userAgent: "A".repeat(400) });
      expect(await store.createSession(session)).toBe(true);

      const [row] = await sessionRows(db, person.id);
      expect(row).toBeDefined();
      expect(row?.id).toBe(session.id);
      expect(row?.token_hash.equals(session.tokenHash)).toBe(true);
      expect(row?.token_hash.equals(session.token)).toBe(false);
      expect(row?.level).toBe("full");
      expect(row?.remember).toBe(false);
      expect(row?.ip_prefix).toBe("203.0.0.0/16");
      expect(row?.user_agent).toBe("A".repeat(256));
      const created = row?.created_at.getTime() ?? 0;
      expect((row?.expires_at.getTime() ?? 0) - created).toBe(30 * DAY_MS);
      expect((row?.absolute_expires_at.getTime() ?? 0) - created).toBe(180 * DAY_MS);
    });

    it("uses the 90-day window with remember", async () => {
      const person = await account();
      expect(await store.createSession(newSession(person.id, { remember: true }))).toBe(true);
      const [row] = await sessionRows(db, person.id);
      expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBe(90 * DAY_MS);
      expect(row?.remember).toBe(true);
    });

    it("keeps an IPv6 /48 and accepts an unknown prefix and user agent", async () => {
      const person = await account();
      expect(await store.createSession(newSession(person.id, { ipPrefix: "2001:db8:1::/48", userAgent: null }))).toBe(true);
      expect(await store.createSession(newSession(person.id, { ipPrefix: null }))).toBe(true);
      const rows = await sessionRows(db, person.id);
      expect(new Set(rows.map((row) => row.ip_prefix))).toEqual(new Set([null, "2001:db8:1::/48"]));
    });

    it("sets the account's last sign-in time", async () => {
      const person = await account();
      expect(await store.createSession(newSession(person.id))).toBe(true);
      const rows = await asSystem(db, (tx) => tx<{ last_sign_in_at: Date | null }[]>`SELECT last_sign_in_at FROM accounts WHERE id = ${person.id}`);
      expect(rows[0]?.last_sign_in_at).toBeInstanceOf(Date);
    });

    it("deletes the session of the replaced token in the same call", async () => {
      const person = await account();
      const old = newSession(person.id);
      expect(await store.createSession(old)).toBe(true);
      const next = newSession(person.id, { replacedTokenHash: old.tokenHash });
      expect(await store.createSession(next)).toBe(true);
      expect((await sessionRows(db, person.id)).map((row) => row.id)).toEqual([next.id]);
      expect(await store.lookupSession(old.tokenHash)).toBeUndefined();
      expect((await store.lookupSession(next.tokenHash))?.accountId).toBe(person.id);
    });

    it("deletes the session of another account that the request's token belonged to", async () => {
      const first = await account();
      const second = await account();
      const old = newSession(first.id);
      expect(await store.createSession(old)).toBe(true);
      expect(await store.createSession(newSession(second.id, { replacedTokenHash: old.tokenHash }))).toBe(true);
      expect(await sessionRows(db, first.id)).toEqual([]);
    });

    it("creates nothing, and deletes nothing, for a disabled account or an unknown one", async () => {
      const live = await account();
      const old = newSession(live.id);
      expect(await store.createSession(old)).toBe(true);

      const disabled = await account({ disabledAt: new Date("2026-01-01T00:00:00Z") });
      expect(await store.createSession(newSession(disabled.id, { replacedTokenHash: old.tokenHash }))).toBe(false);
      expect(await store.createSession(newSession(freshId(), { replacedTokenHash: old.tokenHash }))).toBe(false);
      expect(await sessionRows(db, disabled.id)).toEqual([]);
      expect((await store.lookupSession(old.tokenHash))?.accountId).toBe(live.id);
    });

    it("refuses a token hash that is not 32 bytes before it reaches the database", async () => {
      const person = await account();
      await expect(store.createSession(newSession(person.id, { tokenHash: Buffer.alloc(31) }))).rejects.toThrow(RangeError);
      await expect(store.createSession(newSession(person.id, { replacedTokenHash: Buffer.alloc(5) }))).rejects.toThrow(RangeError);
      await expect(db.app`SELECT sys_session_create(${freshId()}::uuid, ${person.id}::uuid, 'partial', false, NULL, NULL, ${Buffer.alloc(32)}::bytea, NULL)`).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("sys_session_lookup", () => {
    it("resolves a live session to the account, level, workspace, re-authentication and admin flag", async () => {
      const person = await account({ isInstanceAdmin: true });
      const session = newSession(person.id);
      expect(await store.createSession(session)).toBe(true);
      expect(await store.lookupSession(session.tokenHash)).toEqual({
        sessionId: session.id,
        accountId: person.id,
        level: "full",
        activeWorkspaceId: null,
        reauthAt: null,
        isInstanceAdmin: true,
      });
    });

    it("knows nothing of a token it never issued", async () => {
      expect(await store.lookupSession(freshToken().hash)).toBeUndefined();
    });

    it("refuses a revoked session on the very next lookup (T4)", async () => {
      const person = await account();
      const session = newSession(person.id);
      expect(await store.createSession(session)).toBe(true);
      expect((await store.lookupSession(session.tokenHash))?.sessionId).toBe(session.id);
      expect(await store.revokeSession(session.id, person.id)).toBe(true);
      expect(await store.lookupSession(session.tokenHash)).toBeUndefined();
      expect(await sessionRows(db, person.id)).toEqual([]);
    });

    it("refuses a session past its sliding expiry or its absolute expiry", async () => {
      const person = await account();
      const slid = newSession(person.id);
      const absolute = newSession(person.id);
      expect(await store.createSession(slid)).toBe(true);
      expect(await store.createSession(absolute)).toBe(true);
      await asSystem(db, async (tx) => {
        await tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${slid.id}`;
        await tx`UPDATE sessions SET absolute_expires_at = now() - interval '1 second' WHERE id = ${absolute.id}`;
      });
      expect(await store.lookupSession(slid.tokenHash)).toBeUndefined();
      expect(await store.lookupSession(absolute.tokenHash)).toBeUndefined();
    });

    it("refuses the session of a disabled account, and honours it again when the account is enabled", async () => {
      const person = await account();
      const session = newSession(person.id);
      expect(await store.createSession(session)).toBe(true);
      await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${person.id}`);
      expect(await store.lookupSession(session.tokenHash)).toBeUndefined();
      await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = NULL WHERE id = ${person.id}`);
      expect((await store.lookupSession(session.tokenHash))?.accountId).toBe(person.id);
    });

    it("refuses a session created before the account's password_changed_at, and accepts one created after it", async () => {
      const person = await account();
      const before = newSession(person.id);
      expect(await store.createSession(before)).toBe(true);
      await asSystem(db, (tx) => tx`UPDATE accounts SET password_changed_at = now() + interval '1 second' WHERE id = ${person.id}`);
      expect(await store.lookupSession(before.tokenHash)).toBeUndefined();

      await asSystem(db, (tx) => tx`UPDATE accounts SET password_changed_at = now() - interval '1 hour' WHERE id = ${person.id}`);
      const after = newSession(person.id);
      expect(await store.createSession(after)).toBe(true);
      expect((await store.lookupSession(after.tokenHash))?.sessionId).toBe(after.id);
      expect(await store.lookupSession(before.tokenHash)).toBeDefined();
    });

    it("writes last_seen_at at most once a minute and slides the expiry then", async () => {
      const person = await account();
      const session = newSession(person.id);
      expect(await store.createSession(session)).toBe(true);
      const [created] = await sessionRows(db, person.id);

      expect(await store.lookupSession(session.tokenHash)).toBeDefined();
      expect(await store.lookupSession(session.tokenHash)).toBeDefined();
      const [quiet] = await sessionRows(db, person.id);
      expect(quiet?.last_seen_at).toEqual(created?.last_seen_at);
      expect(quiet?.expires_at).toEqual(created?.expires_at);

      await asSystem(db, (tx) => tx`
        UPDATE sessions SET last_seen_at = last_seen_at - interval '2 minutes',
                            expires_at = expires_at - interval '10 days' WHERE id = ${session.id}`);
      const [aged] = await sessionRows(db, person.id);
      expect(await store.lookupSession(session.tokenHash)).toBeDefined();
      const [slid] = await sessionRows(db, person.id);
      expect((slid?.last_seen_at.getTime() ?? 0) - (aged?.last_seen_at.getTime() ?? 0)).toBeGreaterThan(MINUTE_MS);
      expect(slid?.expires_at.getTime() ?? 0).toBeGreaterThan(Date.now() + 29 * DAY_MS);
      expect(slid?.expires_at.getTime() ?? 0).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    });

    it("never slides the expiry past the absolute cap", async () => {
      const person = await account();
      const session = newSession(person.id, { remember: true });
      expect(await store.createSession(session)).toBe(true);
      await asSystem(db, (tx) => tx`
        UPDATE sessions SET last_seen_at = last_seen_at - interval '2 minutes',
                            absolute_expires_at = now() + interval '5 days' WHERE id = ${session.id}`);
      expect(await store.lookupSession(session.tokenHash)).toBeDefined();
      const [row] = await sessionRows(db, person.id);
      expect(row?.expires_at).toEqual(row?.absolute_expires_at);
    });
  });

  describe("sys_session_revoke", () => {
    it("deletes the session of the account it names and nothing else", async () => {
      const owner = await account();
      const stranger = await account();
      const mine = newSession(owner.id);
      const other = newSession(owner.id);
      expect(await store.createSession(mine)).toBe(true);
      expect(await store.createSession(other)).toBe(true);

      expect(await store.revokeSession(mine.id, stranger.id)).toBe(false);
      expect(await sessionRows(db, owner.id)).toHaveLength(2);
      expect(await store.revokeSession(mine.id, owner.id)).toBe(true);
      expect((await sessionRows(db, owner.id)).map((row) => row.id)).toEqual([other.id]);
      expect(await store.revokeSession(mine.id, owner.id)).toBe(false);
    });
  });
});
