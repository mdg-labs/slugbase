import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenRepository, type ApiTokenCreation, type ApiTokenRecord, type NewApiToken } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Personal API tokens (doc 05 section 2.1, doc 02 section 2.9, doc 10 T1, T4 and
// T7): the table, its account policy and the column privileges that keep a hash
// from being read, and the repository that lists, creates and revokes the
// account's own tokens. The failure scenarios: an account that lists or revokes
// another account's token by its id, two creations at once that pass the limit
// of ten together, a token bound to a workspace the account does not belong to,
// and a secret or a hash that the application role can read back.

const HOOK_TIMEOUT_MS = 300_000;
const LIMIT = 10;

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
  await seedAccount(db, { id, email: `tokens${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

/** An account that is a member of a workspace of its own. */
async function member(): Promise<{ accountId: string; workspaceId: string }> {
  const accountId = await account();
  const workspaceId = await seedWorkspace(db, { createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  return { accountId, workspaceId };
}

function tenant<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "api-tokens-test" }, work);
}

/** Runs `work` on the application role with the account setting of a tenant transaction and nothing else: row-level security alone decides what it sees. */
async function asApp<T>(accountId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

function newToken(workspaceId: string, overrides: Partial<NewApiToken> = {}): NewApiToken {
  const secret = randomBytes(32).toString("base64url");
  return {
    id: freshId(),
    workspaceId,
    name: `token ${freshId()}`,
    scope: "read",
    tokenHash: createHash("sha256").update(`slb_${secret}`).digest(),
    tokenPrefix: secret.slice(0, 6),
    expiresInDays: 90,
    limit: LIMIT,
    ...overrides,
  };
}

async function create(accountId: string, token: NewApiToken): Promise<ApiTokenCreation> {
  return tenant(accountId, (tx) => apiTokenRepository(tx).create(token));
}

async function created(accountId: string, token: NewApiToken): Promise<ApiTokenRecord> {
  const outcome = await create(accountId, token);
  if (outcome.kind !== "created") {
    throw new Error(`the token was refused: ${outcome.kind}`);
  }
  return outcome.token;
}

interface StoredRow {
  id: string;
  account_id: string;
  workspace_id: string;
  name: string;
  token_hash: Buffer;
  token_prefix: string;
  scope: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function storedRows(accountId: string): Promise<StoredRow[]> {
  return asSystem(db, async (tx) => [...(await tx<StoredRow[]>`SELECT * FROM api_tokens WHERE account_id = ${accountId} ORDER BY id`)]);
}

describe("the api_tokens table", () => {
  it("has the columns of doc 05 section 2.1", async () => {
    const rows = await db.owner<{ name: string; type: string; nullable: boolean; fallback: string | null }[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid) AS fallback
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.api_tokens'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect(rows.map((row) => `${row.name} ${row.type}${row.nullable ? "" : " NOT NULL"}${row.fallback === null ? "" : ` DEFAULT ${row.fallback}`}`)).toEqual([
      "id uuid NOT NULL",
      "account_id uuid NOT NULL",
      "workspace_id uuid NOT NULL",
      "name text NOT NULL",
      "token_hash bytea NOT NULL",
      "token_prefix text NOT NULL",
      "scope text NOT NULL",
      "expires_at timestamp with time zone",
      "last_used_at timestamp with time zone",
      "last_used_ip_prefix cidr",
      "revoked_at timestamp with time zone",
      "created_at timestamp with time zone NOT NULL DEFAULT now()",
    ]);
  });

  it("binds a token to a membership: the foreign key names workspace and account and cascades", async () => {
    const references = await db.owner<{ target: string; on_delete: string; columns: string[] }[]>`
      SELECT c.confrelid::regclass::text AS target, c.confdeltype::text AS on_delete,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)::text[] AS columns
      FROM pg_constraint c
      WHERE c.conrelid = 'public.api_tokens'::regclass AND c.contype = 'f'`;
    expect([...references]).toEqual([{ target: "workspace_members", on_delete: "c", columns: ["workspace_id", "account_id"] }]);
  });

  it("refuses a name outside 1 to 64 characters, a hash that is not 32 bytes, a prefix that is not 6 characters and a scope other than read and read-write", async () => {
    const { accountId, workspaceId } = await member();
    const insert = (overrides: Partial<{ name: string; hash: Buffer; prefix: string; scope: string }>) => {
      const values = { id: freshId(), name: "CI", hash: randomBytes(32), prefix: "AbCdEf", scope: "read", ...overrides };
      return db.owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
        await tx`
          INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope)
          VALUES (${values.id}, ${accountId}, ${workspaceId}, ${values.name}, ${values.hash}, ${values.prefix}, ${values.scope})`;
      });
    };
    await expect(insert({ name: "" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ name: "x".repeat(65) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ hash: randomBytes(31) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ prefix: "AbCdE" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ scope: "write" })).rejects.toMatchObject({ code: "23514" });
    const hash = randomBytes(32);
    await insert({ name: "x".repeat(64), hash });
    await expect(insert({ name: "other", hash })).rejects.toMatchObject({ code: "23505" });
  });

  it("has row-level security enabled and forced, with the one account policy", async () => {
    const rows = await db.owner<{ enabled: boolean; forced: boolean; policies: string[] }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT array_agg(p.polname ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.api_tokens'::regclass`;
    expect([...rows]).toEqual([{ enabled: true, forced: true, policies: ["api_tokens_account"] }]);
  });

  it("gives slugbase_app no read of token_hash, an INSERT of the columns a creation sets, no DELETE, and an UPDATE of revoked_at alone", async () => {
    const columns = await db.owner<{ column: string; privilege: string }[]>`
      SELECT a.attname AS column, p AS privilege
      FROM pg_attribute a, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p
      WHERE a.attrelid = 'public.api_tokens'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.api_tokens', a.attname, p)
      ORDER BY p, a.attnum`;
    const of = (privilege: string) => columns.filter((row) => row.privilege === privilege).map((row) => row.column);
    expect(of("SELECT")).not.toContain("token_hash");
    expect(of("SELECT")).toEqual(["id", "account_id", "workspace_id", "name", "token_prefix", "scope", "expires_at", "last_used_at", "revoked_at", "created_at"]);
    expect(of("INSERT")).toEqual(["id", "account_id", "workspace_id", "name", "token_hash", "token_prefix", "scope", "expires_at"]);
    expect(of("UPDATE")).toEqual(["revoked_at"]);
    const table = await db.owner<{ privilege: string }[]>`
      SELECT p AS privilege FROM unnest(ARRAY['INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      WHERE has_table_privilege('slugbase_app', 'public.api_tokens', p)`;
    expect([...table]).toEqual([]);
  });
});

describe("what the application role can write on creation", () => {
  const COLUMNS: readonly [column: string, value: string][] = [
    ["revoked_at", "now()"],
    ["last_used_at", "now()"],
    ["last_used_ip_prefix", "'203.0.113.0/24'::cidr"],
    ["created_at", "now()"],
  ];

  it.each(COLUMNS)("refuses an insert that sets %s, with a privilege error, and stores no row", async (column, value) => {
    const { accountId, workspaceId } = await member();
    const id = freshId();
    await expect(
      asApp(
        accountId,
        (tx) =>
          tx.unsafe(
            `INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope, ${column})
             VALUES ($1, $2, $3, 'planted', $4, 'AbCdEf', 'read', ${value})`,
            [id, accountId, workspaceId, randomBytes(32)],
          ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await storedRows(accountId)).map((row) => row.id)).not.toContain(id);
  });

  it("refuses an insert that leaves the column list to the table, which names every column", async () => {
    const { accountId, workspaceId } = await member();
    await expect(
      asApp(
        accountId,
        (tx) => tx`
          INSERT INTO api_tokens
          VALUES (${freshId()}, ${accountId}, ${workspaceId}, 'planted', ${randomBytes(32)}, 'AbCdEf', 'read', null, null, null, null, now())`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("holds no table-level INSERT, which a column-level grant applied over it would leave in place", async () => {
    const rows = await db.owner<{ table_level: boolean }[]>`SELECT has_table_privilege('slugbase_app', 'public.api_tokens', 'INSERT') AS table_level`;
    expect([...rows]).toEqual([{ table_level: false }]);
  });

  it("still stores a token through the repository, which sets only the granted columns", async () => {
    const { accountId, workspaceId } = await member();
    const token = newToken(workspaceId);
    await created(accountId, token);
    const [row] = await storedRows(accountId);
    expect(row).toMatchObject({ id: token.id, revoked_at: null, last_used_at: null });
  });
});

describe("what the application role can read back", () => {
  it("never the hash: a query that names it or selects every column is refused", async () => {
    const { accountId, workspaceId } = await member();
    await created(accountId, newToken(workspaceId));
    await expect(asApp(accountId, (tx) => tx`SELECT token_hash FROM api_tokens`)).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(accountId, (tx) => tx`SELECT * FROM api_tokens`)).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps only the SHA-256 of the token and its prefix, and no copy of the secret in any column", async () => {
    const { accountId, workspaceId } = await member();
    const secret = `slb_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(secret).digest();
    await created(accountId, newToken(workspaceId, { tokenHash: hash, tokenPrefix: secret.slice(4, 10) }));
    const [row] = await storedRows(accountId);
    expect(row?.token_hash).toEqual(hash);
    expect(row?.token_prefix).toBe(secret.slice(4, 10));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret.slice(4));
  });
});

describe("the account policy", () => {
  it("shows an account its own rows and none of another account's, whatever it asks for", async () => {
    const alice = await member();
    const bob = await member();
    const aliceToken = await created(alice.accountId, newToken(alice.workspaceId));
    const bobToken = await created(bob.accountId, newToken(bob.workspaceId));
    const seenByBob = await asApp(bob.accountId, (tx) => tx<{ id: string }[]>`SELECT id FROM api_tokens`);
    expect(seenByBob.map((row) => row.id)).toEqual([bobToken.id]);
    const byId = await asApp(bob.accountId, (tx) => tx`SELECT id FROM api_tokens WHERE id = ${aliceToken.id}`);
    expect([...byId]).toEqual([]);
    const outside = await db.app.begin((tx) => tx`SELECT id FROM api_tokens`);
    expect([...outside]).toEqual([]);
  });

  it("refuses a row of another account on insert, and changes no row of another account on update", async () => {
    const alice = await member();
    const bob = await member();
    const aliceToken = await created(alice.accountId, newToken(alice.workspaceId));
    await expect(
      asApp(
        bob.accountId,
        (tx) => tx`
          INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope)
          VALUES (${freshId()}, ${alice.accountId}, ${alice.workspaceId}, 'planted', ${randomBytes(32)}, 'AbCdEf', 'read')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const revoked = await asApp(bob.accountId, (tx) => tx`UPDATE api_tokens SET revoked_at = now() WHERE id = ${aliceToken.id} RETURNING id`);
    expect([...revoked]).toEqual([]);
    expect((await storedRows(alice.accountId)).map((row) => row.revoked_at)).toEqual([null]);
  });

  it("refuses a token for a workspace the account is not a member of, by the foreign key as well as the repository", async () => {
    const alice = await member();
    const bob = await member();
    await expect(
      asApp(
        alice.accountId,
        (tx) => tx`
          INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope)
          VALUES (${freshId()}, ${alice.accountId}, ${bob.workspaceId}, 'foreign', ${randomBytes(32)}, 'AbCdEf', 'read')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("creating a token", () => {
  it("stores it bound to the workspace and returns it with the workspace's name and no secret", async () => {
    const { accountId, workspaceId } = await member();
    const token = newToken(workspaceId, { name: "CI", scope: "read-write", expiresInDays: 30 });
    const record = await created(accountId, token);
    expect(record).toMatchObject({ id: token.id, name: "CI", workspaceId, workspaceName: "Test workspace", scope: "read-write", prefix: token.tokenPrefix, lastUsedAt: null });
    expect(Object.keys(record).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "prefix", "scope", "workspaceId", "workspaceName"]);
    const [row] = await storedRows(accountId);
    expect(row).toMatchObject({ id: token.id, account_id: accountId, workspace_id: workspaceId, revoked_at: null });
  });

  it("sets the expiry from the database clock, and none for null", async () => {
    const { accountId, workspaceId } = await member();
    for (const days of [30, 90, 365]) {
      const record = await created(accountId, newToken(workspaceId, { expiresInDays: days }));
      const lifetime = (record.expiresAt?.getTime() ?? 0) - record.createdAt.getTime();
      expect(Math.abs(lifetime - days * 86_400_000)).toBeLessThan(60_000);
    }
    expect((await created(accountId, newToken(workspaceId, { expiresInDays: null }))).expiresAt).toBeNull();
  });

  it("answers not_a_member, and writes nothing, for a workspace the account does not belong to, one being deleted and one that does not exist", async () => {
    const alice = await member();
    const bob = await member();
    const deleting = await seedWorkspace(db, { deletingAt: new Date() });
    await seedMember(db, { workspaceId: deleting, accountId: alice.accountId });
    for (const workspaceId of [bob.workspaceId, deleting, freshId()]) {
      expect(await create(alice.accountId, newToken(workspaceId))).toEqual({ kind: "not_a_member" });
    }
    expect(await storedRows(alice.accountId)).toEqual([]);
  });

  it("answers name_taken for a name the account already uses, case for case, and lets another account use it", async () => {
    const alice = await member();
    const bob = await member();
    await created(alice.accountId, newToken(alice.workspaceId, { name: "CI" }));
    expect(await create(alice.accountId, newToken(alice.workspaceId, { name: "CI" }))).toEqual({ kind: "name_taken" });
    expect((await create(bob.accountId, newToken(bob.workspaceId, { name: "CI" }))).kind).toBe("created");
    expect(await storedRows(alice.accountId)).toHaveLength(1);
  });

  it("answers limit_reached for the eleventh active token, and counts neither a revoked nor an expired one", async () => {
    const { accountId, workspaceId } = await member();
    const first = await created(accountId, newToken(workspaceId));
    for (let count = 1; count < LIMIT; count += 1) {
      await created(accountId, newToken(workspaceId));
    }
    expect(await create(accountId, newToken(workspaceId))).toEqual({ kind: "limit_reached" });
    expect(await storedRows(accountId)).toHaveLength(LIMIT);

    expect(await tenant(accountId, (tx) => apiTokenRepository(tx).revoke(first.id))).toBe(true);
    expect((await create(accountId, newToken(workspaceId))).kind).toBe("created");
    expect(await create(accountId, newToken(workspaceId))).toEqual({ kind: "limit_reached" });

    await asSystem(db, (tx) => tx`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE account_id = ${accountId} AND revoked_at IS NULL`);
    expect((await create(accountId, newToken(workspaceId))).kind).toBe("created");
  });

  it("holds the limit when several creations race: of fifteen at once exactly ten are stored", async () => {
    const { accountId, workspaceId } = await member();
    const outcomes = await Promise.all(Array.from({ length: 15 }, () => create(accountId, newToken(workspaceId))));
    expect(outcomes.filter((outcome) => outcome.kind === "created")).toHaveLength(LIMIT);
    expect(outcomes.filter((outcome) => outcome.kind === "limit_reached")).toHaveLength(5);
    expect(await storedRows(accountId)).toHaveLength(LIMIT);
  });

  it("holds the name when two creations race: of two with one name exactly one is stored", async () => {
    const { accountId, workspaceId } = await member();
    const outcomes = await Promise.all([1, 2, 3].map(() => create(accountId, newToken(workspaceId, { name: "race" }))));
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["created", "name_taken", "name_taken"]);
    expect(await storedRows(accountId)).toHaveLength(1);
  });

  it("counts a limit per account: another account's tokens do not use it up", async () => {
    const alice = await member();
    const bob = await member();
    for (let count = 0; count < LIMIT; count += 1) {
      await created(alice.accountId, newToken(alice.workspaceId));
    }
    expect((await create(bob.accountId, newToken(bob.workspaceId))).kind).toBe("created");
  });
});

describe("listing tokens", () => {
  it("lists the account's tokens across its workspaces, newest first, and never another account's", async () => {
    const alice = await member();
    const bob = await member();
    const second = await seedWorkspace(db, { name: "Second" });
    await seedMember(db, { workspaceId: second, accountId: alice.accountId });
    const one = await created(alice.accountId, newToken(alice.workspaceId, { id: "0192f3a0-dddd-7000-8000-000000000001", name: "one" }));
    const two = await created(alice.accountId, newToken(second, { id: "0192f3a0-dddd-7000-8000-000000000002", name: "two" }));
    await created(bob.accountId, newToken(bob.workspaceId));
    const listed = await tenant(alice.accountId, (tx) => apiTokenRepository(tx).list(null, 50));
    expect(listed).toEqual([two, one]);
    expect(listed.map((token) => token.workspaceName)).toEqual(["Second", "Test workspace"]);
  });

  it("leaves out a revoked token and one bound to a workspace that is being deleted", async () => {
    const { accountId, workspaceId } = await member();
    const kept = await created(accountId, newToken(workspaceId));
    const revoked = await created(accountId, newToken(workspaceId));
    await tenant(accountId, (tx) => apiTokenRepository(tx).revoke(revoked.id));
    const dying = await seedWorkspace(db);
    await seedMember(db, { workspaceId: dying, accountId });
    await created(accountId, newToken(dying));
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${dying}`);
    expect(await tenant(accountId, (tx) => apiTokenRepository(tx).list(null, 50))).toEqual([kept]);
  });

  it("pages by the identifier of the last token on the page", async () => {
    const { accountId, workspaceId } = await member();
    const ids = ["01", "02", "03", "04", "05"].map((suffix) => `0192f3a0-eeee-7000-8000-0000000000${suffix}`);
    for (const id of ids) {
      await created(accountId, newToken(workspaceId, { id }));
    }
    const repository = <T>(work: (tokens: ReturnType<typeof apiTokenRepository>) => Promise<T>) => tenant(accountId, (tx) => work(apiTokenRepository(tx)));
    const first = await repository((tokens) => tokens.list(null, 2));
    expect(first.map((token) => token.id)).toEqual([ids[4], ids[3]]);
    const second = await repository((tokens) => tokens.list(first.at(-1)?.id ?? null, 2));
    expect(second.map((token) => token.id)).toEqual([ids[2], ids[1]]);
    const third = await repository((tokens) => tokens.list(second.at(-1)?.id ?? null, 2));
    expect(third.map((token) => token.id)).toEqual([ids[0]]);
  });
});

describe("revoking a token", () => {
  it("revokes the account's own token, keeps the row and the time of the first revocation, and says true again for a repeat", async () => {
    const { accountId, workspaceId } = await member();
    const token = await created(accountId, newToken(workspaceId));
    expect(await tenant(accountId, (tx) => apiTokenRepository(tx).revoke(token.id))).toBe(true);
    const [first] = await storedRows(accountId);
    expect(first?.revoked_at).toBeInstanceOf(Date);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await tenant(accountId, (tx) => apiTokenRepository(tx).revoke(token.id))).toBe(true);
    const [second] = await storedRows(accountId);
    expect(second?.revoked_at).toEqual(first?.revoked_at);
  });

  it("says false for another account's token and for an unknown id, and leaves the token active", async () => {
    const alice = await member();
    const bob = await member();
    const token = await created(alice.accountId, newToken(alice.workspaceId));
    expect(await tenant(bob.accountId, (tx) => apiTokenRepository(tx).revoke(token.id))).toBe(false);
    expect(await tenant(bob.accountId, (tx) => apiTokenRepository(tx).revoke(freshId()))).toBe(false);
    expect((await storedRows(alice.accountId)).map((row) => row.revoked_at)).toEqual([null]);
  });

  it("frees the name of a revoked token for a new one", async () => {
    const { accountId, workspaceId } = await member();
    const token = await created(accountId, newToken(workspaceId, { name: "CI" }));
    expect((await create(accountId, newToken(workspaceId, { name: "CI" }))).kind).toBe("name_taken");
    await tenant(accountId, (tx) => apiTokenRepository(tx).revoke(token.id));
    expect((await create(accountId, newToken(workspaceId, { name: "CI" }))).kind).toBe("created");
  });
});

describe("losing the membership", () => {
  it("deletes the tokens bound to that workspace and no other", async () => {
    const { accountId, workspaceId } = await member();
    const other = await seedWorkspace(db);
    await seedMember(db, { workspaceId: other, accountId });
    await created(accountId, newToken(workspaceId));
    const kept = await created(accountId, newToken(other));
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`);
    expect((await storedRows(accountId)).map((row) => row.id)).toEqual([kept.id]);
  });
});
