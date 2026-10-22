import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// The first login of an OIDC identity nobody has linked (doc 05 section 3.3, doc 02 sections 2.2 and 2.8,
// doc 10 T17 and T20): it is linked to the enabled account that holds the verified address, or an account is
// created for it, in one transaction with its session. The failure scenarios: an identity linked to an account
// whose address nobody verified (the visitor who registered it first keeps a password the owner never set), to
// a disabled account, or moved away from the account that holds it; an account created for an address that
// has one, or left behind when a later step of the first login fails.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "event.account.created";
const SUBJECT = "first-login-subject";

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
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  await db.owner`TRUNCATE accounts CASCADE`;
});

let number = 0;

function address(): string {
  number += 1;
  return `Person${String(number)}@Example.test`;
}

async function account(email: string, options: { verified?: boolean; disabled?: boolean; mfa?: boolean } = {}): Promise<string> {
  const id = freshId();
  await seedAccount(db, { id, email, passwordHash: "$argon2id$stub", disabledAt: options.disabled === true ? new Date() : null, emailVerified: options.verified ?? true });
  if (options.mfa === true) {
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = ${Buffer.alloc(40, 2)}, mfa_secret_key_id = 'k1', mfa_enabled_at = now() WHERE id = ${id}`);
  }
  return id;
}

async function link(accountId: string, subject: string): Promise<void> {
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${freshId()}, ${accountId}, 'idp', ${subject}, 'old@example.test')`;
  });
}

type Request = Parameters<AuthStore["signInWithIdentity"]>[0];
type Create = NonNullable<NonNullable<Request["firstLogin"]>["create"]>;

function create(overrides: Partial<Create> = {}): Create {
  const accountId = freshId();
  return {
    accountId,
    displayName: "Ada",
    locale: "de",
    onCreated: [{ id: freshId(), queue: QUEUE, data: { eventId: freshId(), accountId, path: "oidc" } }],
    ...overrides,
  };
}

function firstLogin(email: string, overrides: Partial<Request> & { create?: Create } = {}): { -readonly [Key in keyof Request]: Request[Key] } {
  const { create: toCreate, ...rest } = overrides;
  return {
    provider: "idp",
    subject: SUBJECT,
    sessionId: freshId(),
    ipPrefix: "203.0.0.0/16",
    userAgent: "test agent",
    tokenHash: freshToken().hash,
    replacedTokenHash: null,
    firstLogin: { identityId: freshId(), email, ...(toCreate === undefined ? {} : { create: toCreate }) },
    ...rest,
  };
}

interface IdentityRow {
  account_id: string;
  provider: string;
  subject: string;
  email_at_link: string;
}

async function identities(): Promise<IdentityRow[]> {
  return [...(await asSystem(db, (tx) => tx<IdentityRow[]>`SELECT account_id, provider, subject, email_at_link FROM account_identities ORDER BY created_at, id`))];
}

async function accountCount(): Promise<number> {
  return Number((await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM accounts`))[0]?.n);
}

async function queued(): Promise<string[]> {
  return (await db.app<{ id: string }[]>`SELECT id FROM pgboss.job ORDER BY id`).map((row) => row.id);
}

describe("a first login without an account to create", () => {
  it("links the identity to the enabled account that holds the verified address, whatever case it is written in, and signs it in with a full session", async () => {
    const email = address();
    const holder = await account(email);
    const request = firstLogin(email.toLowerCase());

    expect(await store.signInWithIdentity(request)).toBe("linked");

    expect(await identities()).toEqual([{ account_id: holder, provider: "idp", subject: SUBJECT, email_at_link: email.toLowerCase() }]);
    const sessions = await sessionRows(db, holder);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: request.sessionId, level: "full", user_agent: "test agent" });
    expect(await store.lookupSession(request.tokenHash)).toMatchObject({ accountId: holder, level: "full" });
  });

  it("signs the next login in through the link, without the address", async () => {
    const email = address();
    const holder = await account(email);
    expect(await store.signInWithIdentity(firstLogin(email))).toBe("linked");

    const plain = firstLogin(email);
    delete plain.firstLogin;
    expect(await store.signInWithIdentity(plain)).toBe("signed_in");
    expect(await identities()).toHaveLength(1);
    expect(await sessionRows(db, holder)).toHaveLength(2);
  });

  it("gives an account with a second factor a full session: the provider is trusted for it", async () => {
    const email = address();
    const holder = await account(email, { mfa: true });

    expect(await store.signInWithIdentity(firstLogin(email))).toBe("linked");

    expect((await sessionRows(db, holder)).map((row) => row.level)).toEqual(["full"]);
  });

  it("links nothing to an account whose address nobody verified, and signs nobody in", async () => {
    const email = address();
    const registered = await account(email, { verified: false });

    expect(await store.signInWithIdentity(firstLogin(email))).toBe("refused");
    expect(await store.signInWithIdentity(firstLogin(email, { create: create() }))).toBe("refused");

    expect(await identities()).toEqual([]);
    expect(await sessionRows(db, registered)).toEqual([]);
    expect(await accountCount()).toBe(1);
  });

  it("links nothing to a disabled account", async () => {
    const email = address();
    const disabled = await account(email, { disabled: true });

    expect(await store.signInWithIdentity(firstLogin(email))).toBe("refused");

    expect(await identities()).toEqual([]);
    expect(await sessionRows(db, disabled)).toEqual([]);
  });

  it("links nothing when no account holds the address, creating nothing", async () => {
    expect(await store.signInWithIdentity(firstLogin(address()))).toBe("refused");

    expect(await identities()).toEqual([]);
    expect(await accountCount()).toBe(0);
    expect(await sessionRows(db)).toEqual([]);
  });

  it("never moves an identity another account holds, and signs nobody in", async () => {
    const holderEmail = address();
    const holder = await account(holderEmail);
    const other = await account(address(), { disabled: true });
    await link(other, SUBJECT);

    expect(await store.signInWithIdentity(firstLogin(holderEmail))).toBe("refused");

    expect(await identities()).toEqual([{ account_id: other, provider: "idp", subject: SUBJECT, email_at_link: "old@example.test" }]);
    expect(await sessionRows(db, holder)).toEqual([]);
  });

  it("rejects an address that is empty or not trimmed", async () => {
    await expect(store.signInWithIdentity(firstLogin(""))).rejects.toThrow(RangeError);
    await expect(store.signInWithIdentity(firstLogin(" a@example.test"))).rejects.toThrow(RangeError);
  });
});

describe("a first login that creates an account", () => {
  it("creates a verified account without a password, links the identity, queues the jobs and signs in, in one transaction", async () => {
    const email = address();
    const made = create();
    const request = firstLogin(email, { create: made });

    expect(await store.signInWithIdentity(request)).toBe("created");

    const rows = await asSystem(db, (tx) => tx<{ id: string; email: string; display_name: string; password_hash: string | null; locale: string; verified: boolean; admin: boolean }[]>`
      SELECT id, email, display_name, password_hash, locale, email_verified_at IS NOT NULL AS verified, is_instance_admin AS admin FROM accounts`);
    expect([...rows]).toEqual([{ id: made.accountId, email, display_name: "Ada", password_hash: null, locale: "de", verified: true, admin: false }]);
    expect(await identities()).toEqual([{ account_id: made.accountId, provider: "idp", subject: SUBJECT, email_at_link: email }]);
    expect(await sessionRows(db, made.accountId)).toHaveLength(1);
    expect(await store.lookupSession(request.tokenHash)).toMatchObject({ accountId: made.accountId, level: "full" });
    expect(await queued()).toEqual(made.onCreated.map((job) => job.id));
  });

  it("runs afterCreated in the same transaction, with the writer of that transaction", async () => {
    const seen: string[] = [];
    const made = create({
      afterCreated: async (accountId, workspaces) => {
        seen.push(accountId);
        expect(await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: "'s workspace", ownedMax: null, jobs: [] })).toBe("created");
      },
    });

    expect(await store.signInWithIdentity(firstLogin(address(), { create: made }))).toBe("created");

    expect(seen).toEqual([made.accountId]);
    const owned = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM workspaces`);
    expect(owned[0]?.n).toBe("1");
  });

  it("leaves no account, identity, session, workspace or job when afterCreated rejects", async () => {
    const made = create({
      afterCreated: async (accountId, workspaces) => {
        await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: "'s workspace", ownedMax: null, jobs: [] });
        throw new Error("the workspace could not be made");
      },
    });

    await expect(store.signInWithIdentity(firstLogin(address(), { create: made }))).rejects.toThrow("the workspace could not be made");

    expect(await accountCount()).toBe(0);
    expect(await identities()).toEqual([]);
    expect(await sessionRows(db)).toEqual([]);
    expect(await queued()).toEqual([]);
    expect((await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM workspaces`))[0]?.n).toBe("0");
  });

  it("leaves no account when the session cannot be created", async () => {
    const taken = freshToken();
    const holderEmail = address();
    const holder = await account(holderEmail);
    expect(await store.signInWithIdentity(firstLogin(holderEmail, { subject: "someone-else", tokenHash: taken.hash }))).toBe("linked");
    const before = await sessionRows(db, holder);

    await expect(store.signInWithIdentity(firstLogin(address(), { create: create(), tokenHash: taken.hash }))).rejects.toMatchObject({ code: "23505" });

    expect(await accountCount()).toBe(1);
    expect(await identities()).toHaveLength(1);
    expect(await sessionRows(db, holder)).toEqual(before);
    expect(await queued()).toEqual([]);
  });

  it("links to the account that holds the address instead of creating one, and queues no job", async () => {
    const email = address();
    const holder = await account(email);

    expect(await store.signInWithIdentity(firstLogin(email, { create: create() }))).toBe("linked");

    expect(await accountCount()).toBe(1);
    expect((await identities()).map((row) => row.account_id)).toEqual([holder]);
    expect(await queued()).toEqual([]);
  });

  it("creates nothing for an address an unverified account holds, and none that a disabled account holds", async () => {
    const unverified = address();
    await account(unverified, { verified: false });
    const disabled = address();
    await account(disabled, { disabled: true });

    expect(await store.signInWithIdentity(firstLogin(unverified, { create: create() }))).toBe("refused");
    expect(await store.signInWithIdentity(firstLogin(disabled, { create: create() }))).toBe("refused");

    expect(await accountCount()).toBe(2);
    expect(await identities()).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("creates no account when the identity is already linked to another account, whatever address it asserts", async () => {
    const other = await account(address(), { disabled: true });
    await link(other, SUBJECT);

    expect(await store.signInWithIdentity(firstLogin(address(), { create: create() }))).toBe("refused");

    expect(await accountCount()).toBe(1);
    expect(await identities()).toHaveLength(1);
    expect(await queued()).toEqual([]);
  });
});
