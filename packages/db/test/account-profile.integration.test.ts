import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountProfileRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The profile write of doc 04 section 10.3 (doc 05 section 3.1): the one
// account-level UPDATE the application role holds. The failure scenarios are an
// account that changes a column of its row other than the two the profile owns,
// and one that changes a row of another account.

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
  await seedAccount(db, { id, email: `profile${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

function tenant<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "account-profile-test" }, work);
}

interface Row {
  display_name: string;
  locale: string;
  email: string;
  is_instance_admin: boolean;
  updated_at: Date;
}

function row(id: string): Promise<Row | undefined> {
  return asSystem(db, async (tx) => {
    const [found] = await tx<Row[]>`SELECT display_name, locale, email, is_instance_admin, updated_at FROM accounts WHERE id = ${id}`;
    return found;
  });
}

describe("updateProfile", () => {
  it("writes the display name and the locale of the account of the transaction and answers its profile", async () => {
    const id = await account();
    const before = await row(id);

    const profile = await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ displayName: "Ada Lovelace", locale: "de" }));

    expect(profile).toMatchObject({ id, displayName: "Ada Lovelace", locale: "de", hasPassword: true });
    const after = await row(id);
    expect(after).toMatchObject({ display_name: "Ada Lovelace", locale: "de", email: before?.email });
    expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Number.POSITIVE_INFINITY);
  });

  it("keeps a field the changes leave out", async () => {
    const id = await account();
    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ locale: "de" }));
    expect(await row(id)).toMatchObject({ display_name: "Test account", locale: "de" });

    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ displayName: "Renamed" }));
    expect(await row(id)).toMatchObject({ display_name: "Renamed", locale: "de" });
  });

  it("writes nothing for no change and still answers the profile", async () => {
    const id = await account();
    const before = await row(id);
    const profile = await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({}));
    expect(profile).toMatchObject({ id, displayName: "Test account" });
    expect(await row(id)).toEqual(before);
  });

  it("changes no other account, and answers nothing for an account whose row is not visible", async () => {
    const mine = await account();
    const other = await account();
    const before = await row(other);

    await tenant(mine, (tx) => accountProfileRepository(tx).updateProfile({ displayName: "Mine", locale: "de" }));
    expect(await row(other)).toEqual(before);

    const unknown = freshId();
    expect(await tenant(unknown, (tx) => accountProfileRepository(tx).updateProfile({ displayName: "Nobody" }))).toBeUndefined();
    expect(await row(other)).toEqual(before);
  });

  it("refuses a value the table's checks refuse, and leaves the row as it was", async () => {
    const id = await account();
    const before = await row(id);
    await expect(tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ displayName: "x".repeat(101) }))).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ displayName: "" }))).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await row(id)).toEqual(before);
  });
});

describe("the application role's update privilege on accounts", () => {
  it("covers display_name and locale and no other column, and no table-wide privilege", async () => {
    const rows = await db.owner<{ column: string; app: boolean }[]>`
      SELECT a.attname AS column, has_column_privilege('slugbase_app', 'public.accounts', a.attname, 'UPDATE') AS app
      FROM pg_attribute a
      WHERE a.attrelid = 'public.accounts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect(rows.filter((found) => found.app).map((found) => found.column)).toEqual(["display_name", "locale"]);
    const [table] = await db.owner<{ app: boolean }[]>`SELECT has_table_privilege('slugbase_app', 'public.accounts', 'UPDATE') AS app`;
    expect(table?.app).toBe(false);
  });

  it("refuses a statement that sets the email, the instance admin flag or the password hash", async () => {
    const id = await account();
    const before = await row(id);
    for (const column of ["email = 'taken@example.test'", "is_instance_admin = true", "password_hash = 'x'", "disabled_at = now()", "id = gen_random_uuid()"]) {
      await expect(
        db.app.begin(async (tx) => {
          await tx`SELECT set_config('app.account_id', ${id}, true)`;
          return tx.unsafe(`UPDATE public.accounts SET ${column} WHERE id = '${id}'`);
        }),
        column,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await row(id)).toEqual(before);
  });

  it("matches no row of another account, however the statement names it", async () => {
    const mine = await account();
    const other = await account();
    const before = await row(other);
    const updated = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${mine}, true)`;
      return tx.unsafe(`UPDATE public.accounts SET display_name = 'Hijacked' WHERE id = '${other}' RETURNING id`);
    });
    expect([...updated]).toEqual([]);
    expect(await row(other)).toEqual(before);

    const outside = await db.app.unsafe(`UPDATE public.accounts SET display_name = 'Hijacked' RETURNING id`);
    expect([...outside]).toEqual([]);
  });
});
