import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type NewRegistration } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId } from "./support/auth-fixture.ts";

// Self-registration (doc 05 section 3.3, doc 02 section 2.2, doc 10 T8): an unverified account
// is created through sys_create_account, with its jobs queued in the same transaction. The
// failure scenarios: a registration of an address that has an account changes the account in
// any way or answers differently from a new one; a job that cannot be queued leaves an account.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;
const QUEUE = "mail.send";

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
  store = createAuthStore({ url: appUrl(db), poolSize: PARALLEL_CALLS });
  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes and reads.
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

let emailNumber = 0;

function registration(overrides: Partial<NewRegistration> = {}): NewRegistration {
  emailNumber += 1;
  const accountId = overrides.accountId ?? freshId();
  return {
    accountId,
    email: `register${String(emailNumber)}@example.test`,
    displayName: "Ada",
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    locale: "de",
    onCreated: [{ id: freshId(), queue: QUEUE, data: { template: "verifyEmail", accountId } }],
    onTaken: [{ id: freshId(), queue: QUEUE, data: { template: "verifyEmail", accountId } }],
    ...overrides,
  };
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  locale: string;
  email_verified_at: Date | null;
  is_instance_admin: boolean;
}

async function accounts(): Promise<AccountRow[]> {
  return [...(await asSystem(db, (tx) => tx<AccountRow[]>`SELECT id, email, display_name, password_hash, locale, email_verified_at, is_instance_admin FROM accounts ORDER BY created_at, id`))];
}

async function queued(): Promise<{ id: string; name: string; data: Record<string, unknown> }[]> {
  return [...(await db.app<{ id: string; name: string; data: Record<string, unknown> }[]>`SELECT id, name, data FROM pgboss.job ORDER BY id`)];
}

describe("registerAccount", () => {
  it("creates an unverified account that is not an instance admin, with the jobs of onCreated queued in the same transaction", async () => {
    const input = registration();

    expect(await store.registerAccount(input)).toBe(true);

    expect(await accounts()).toEqual([
      {
        id: input.accountId,
        email: input.email,
        display_name: "Ada",
        password_hash: input.passwordHash,
        locale: "de",
        email_verified_at: null,
        is_instance_admin: false,
      },
    ]);
    expect(await queued()).toEqual(input.onCreated.map((job) => ({ id: job.id, name: job.queue, data: job.data })));
  });

  it("changes nothing of an account that has the address, whatever case it is written in, and queues the jobs of onTaken instead", async () => {
    const first = registration({ email: "Taken@Example.test" });
    await store.registerAccount(first);
    await db.owner`TRUNCATE pgboss.job`;
    const before = await accounts();

    const second = registration({ email: "taken@example.TEST", displayName: "Mallory", passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$b3RoZXI$b3RoZXI", locale: "en" });
    expect(await store.registerAccount(second)).toBe(false);

    expect(await accounts()).toEqual(before);
    expect(await queued()).toEqual(second.onTaken.map((job) => ({ id: job.id, name: job.queue, data: job.data })));
  });

  it("queues the same number of jobs, of the same queue, for a new address and for a taken one", async () => {
    const created = registration();
    await store.registerAccount(created);
    const afterCreated = await queued();
    await db.owner`TRUNCATE pgboss.job`;
    await store.registerAccount(registration({ email: created.email }));

    expect((await queued()).map((job) => job.name)).toEqual(afterCreated.map((job) => job.name));
  });

  it("creates one account when many registrations of one address arrive at once", async () => {
    const email = "race@example.test";
    const answers = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.registerAccount(registration({ email }))));

    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(await accounts()).toHaveLength(1);
    expect(await queued()).toHaveLength(PARALLEL_CALLS);
  });

  it("leaves no account when a job cannot be queued, because its queue does not exist", async () => {
    const input = registration();
    const broken = { ...input, onCreated: [{ id: freshId(), queue: "missing.queue", data: {} }] };

    await expect(store.registerAccount(broken)).rejects.toMatchObject({ name: "QueueMissingError" });

    expect(await accounts()).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("refuses an address, a name or a locale the table does not accept, and writes nothing", async () => {
    await expect(store.registerAccount(registration({ locale: "fr" }))).rejects.toMatchObject({ code: "23514" });
    await expect(store.registerAccount(registration({ displayName: "" }))).rejects.toMatchObject({ code: "23514" });
    expect(await accounts()).toEqual([]);
    expect(await queued()).toEqual([]);
  });
});
