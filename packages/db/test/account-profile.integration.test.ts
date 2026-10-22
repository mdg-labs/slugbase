import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountProfileRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The profile write of doc 04 section 10.3 (doc 05 section 3.1): the one
// account-level UPDATE the application role holds. The failure scenarios are an
// account that changes a column of its row other than the ones the profile owns,
// one that changes a row of another account, and a preference change that applies
// in part.

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

interface PreferenceRow {
  theme: string;
  accent: string | null;
  default_bookmark_view: string;
  single_key_shortcuts: boolean;
  ai_opt_out: boolean;
  analytics_consent: string;
  consent_at: Date | null;
  onboarding: unknown;
  signin_alerts: boolean;
}

function preferences(id: string): Promise<PreferenceRow | undefined> {
  return asSystem(db, async (tx) => {
    const [found] = await tx<PreferenceRow[]>`
      SELECT theme, accent, default_bookmark_view, single_key_shortcuts, ai_opt_out, analytics_consent, consent_at, onboarding, signin_alerts
      FROM accounts WHERE id = ${id}`;
    return found;
  });
}

describe("updateProfile preferences", () => {
  it("answers the defaults of a new account", async () => {
    const id = await account();
    const profile = await tenant(id, (tx) => accountProfileRepository(tx).profile());
    expect(profile).toMatchObject({
      theme: "system",
      accent: null,
      defaultBookmarkView: "grid",
      singleKeyShortcuts: true,
      signinAlerts: true,
      aiOptOut: false,
      analyticsConsent: "unset",
      onboarding: { browserSetupDone: false, importDone: false, checklistDismissed: false },
    });
  });

  it("turns the sign-in alerts off and on again, and leaves the other preferences alone", async () => {
    const id = await account();
    const before = await preferences(id);
    const off = await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ signinAlerts: false }));
    expect(off?.signinAlerts).toBe(false);
    expect(await preferences(id)).toEqual({ ...before, signin_alerts: false });
    const on = await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ signinAlerts: true }));
    expect(on?.signinAlerts).toBe(true);
    expect(await preferences(id)).toEqual(before);
  });

  it("writes every preference and answers them", async () => {
    const id = await account();
    const profile = await tenant(id, (tx) =>
      accountProfileRepository(tx).updateProfile({
        theme: "dark",
        accent: "teal",
        defaultBookmarkView: "table",
        singleKeyShortcuts: false,
        aiOptOut: true,
      }),
    );
    expect(profile).toMatchObject({ theme: "dark", accent: "teal", defaultBookmarkView: "table", singleKeyShortcuts: false, aiOptOut: true });
    expect(await preferences(id)).toMatchObject({
      theme: "dark",
      accent: "teal",
      default_bookmark_view: "table",
      single_key_shortcuts: false,
      ai_opt_out: true,
    });
  });

  it("stores the analytics consent with the time of the choice, and clears the time for unset", async () => {
    const id = await account();
    expect((await preferences(id))?.consent_at).toBeNull();

    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ analyticsConsent: "granted" }));
    const granted = await preferences(id);
    expect(granted).toMatchObject({ analytics_consent: "granted" });
    expect(granted?.consent_at).toBeInstanceOf(Date);

    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ analyticsConsent: "denied" }));
    expect(await preferences(id)).toMatchObject({ analytics_consent: "denied", consent_at: expect.any(Date) as Date });

    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ analyticsConsent: "unset" }));
    expect(await preferences(id)).toMatchObject({ analytics_consent: "unset", consent_at: null });
  });

  it("leaves the consent and its time alone when another preference changes", async () => {
    const id = await account();
    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ analyticsConsent: "granted" }));
    const before = await preferences(id);
    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ theme: "light" }));
    expect(await preferences(id)).toMatchObject({ analytics_consent: "granted", consent_at: before?.consent_at, theme: "light" });
  });

  it("merges the onboarding keys given into the stored state and keeps the others", async () => {
    const id = await account();
    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ onboarding: { importDone: true } }));
    expect(await preferences(id)).toMatchObject({ onboarding: { importDone: true } });
    const profile = await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ onboarding: { checklistDismissed: true } }));
    expect(profile?.onboarding).toEqual({ browserSetupDone: false, importDone: true, checklistDismissed: true });
    expect(await preferences(id)).toMatchObject({ onboarding: { importDone: true, checklistDismissed: true } });

    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ onboarding: {} }));
    expect((await preferences(id))?.onboarding).toEqual({ importDone: true, checklistDismissed: true });
  });

  it("applies none of the changes when one of them is refused, and leaves the sign-in alerts alone", async () => {
    const id = await account();
    const before = await preferences(id);
    await expect(
      tenant(id, (tx) =>
        accountProfileRepository(tx).updateProfile({ theme: "dark", aiOptOut: true, defaultBookmarkView: "list" as unknown as "grid" }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await preferences(id)).toEqual(before);
  });

  it("changes the preferences of the account of the transaction only", async () => {
    const mine = await account();
    const other = await account();
    const before = await preferences(other);
    await tenant(mine, (tx) => accountProfileRepository(tx).updateProfile({ theme: "dark", accent: "rose", singleKeyShortcuts: false, onboarding: { importDone: true } }));
    expect(await preferences(other)).toEqual(before);
  });
});

describe("the application role's update privilege on accounts", () => {
  it("covers the profile and preference columns and no other column, and no table-wide privilege", async () => {
    const rows = await db.owner<{ column: string; app: boolean }[]>`
      SELECT a.attname AS column, has_column_privilege('slugbase_app', 'public.accounts', a.attname, 'UPDATE') AS app
      FROM pg_attribute a
      WHERE a.attrelid = 'public.accounts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect(rows.filter((found) => found.app).map((found) => found.column)).toEqual([
      "display_name",
      "locale",
      "theme",
      "accent",
      "default_bookmark_view",
      "single_key_shortcuts",
      "signin_alerts",
      "ai_opt_out",
      "analytics_consent",
      "consent_at",
      "onboarding",
    ]);
    const [table] = await db.owner<{ app: boolean }[]>`SELECT has_table_privilege('slugbase_app', 'public.accounts', 'UPDATE') AS app`;
    expect(table?.app).toBe(false);
  });

  it("refuses a statement that sets the email, the instance admin flag or the password hash", async () => {
    const id = await account();
    const before = await row(id);
    for (const column of ["email = 'taken@example.test'", "is_instance_admin = true", "password_hash = 'x'", "disabled_at = now()", "id = gen_random_uuid()", "last_sign_in_at = now()"]) {
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

// The profile is read in three statements: the row, then the two flags that the column privileges keep out of the application's
// reach. A commit of another transaction can land between them, and then a flag function answers NULL for the vanished account.
// The test stops the profile's read inside one flag function for its account only, deletes the account on another connection,
// and lets the read go on, so the cut falls at the same place on every run.

const FLAG_PAUSE_KEY = 548_002;

type FlagFunction = "sys_account_has_password" | "sys_account_mfa_enabled";

const FLAG_COLUMN: Record<FlagFunction, string> = {
  sys_account_has_password: "a.password_hash IS NOT NULL",
  sys_account_mfa_enabled: "a.mfa_enabled_at IS NOT NULL",
};

/** Resolves once a backend waits for the advisory lock of `key`. */
async function untilWaitingForAdvisoryLock(key: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [waiting] = await db.owner<{ waiting: string }[]>`
      SELECT count(*) AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${key}`;
    if (Number(waiting?.waiting) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no backend waits for the pause lock");
}

/**
 * Replaces `fn` by a function that waits for the shared advisory lock of FLAG_PAUSE_KEY when it is called for `accountId`, and
 * otherwise answers as before, then runs `during`; the function is put back as it was.
 */
async function withPausedFlag<T>(fn: FlagFunction, accountId: string, during: () => Promise<T>): Promise<T> {
  const [stored] = await db.owner<{ definition: string }[]>`SELECT pg_get_functiondef(${`public.${fn}()`}::regprocedure) AS definition`;
  const original = stored?.definition;
  if (original === undefined) {
    throw new Error(`${fn} is not defined`);
  }
  const paused = `
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS boolean
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
    BEGIN
      IF public.app_account_id() = '${accountId}'::uuid THEN
        PERFORM pg_advisory_xact_lock_shared(${String(FLAG_PAUSE_KEY)});
      END IF;
      RETURN (SELECT ${FLAG_COLUMN[fn]} FROM public.accounts a WHERE a.id = public.app_account_id());
    END
    $$`;
  await db.owner.unsafe(paused);
  try {
    return await during();
  } finally {
    await db.owner.unsafe(original);
  }
}

describe("profile when the account is deleted while it is read", () => {
  it.each<FlagFunction>(["sys_account_has_password", "sys_account_mfa_enabled"])(
    "answers undefined, and does not throw, when the account is deleted and committed before %s answers",
    async (fn) => {
      const id = await account();
      const other = await account();
      const connection = await db.owner.reserve();
      let held = false;
      try {
        await connection`SELECT pg_advisory_lock(${FLAG_PAUSE_KEY})`;
        held = true;
        const profile = await withPausedFlag(fn, id, async () => {
          const reading = tenant(id, (tx) => accountProfileRepository(tx).profile());
          await untilWaitingForAdvisoryLock(FLAG_PAUSE_KEY);
          await asSystem(db, (tx) => tx`DELETE FROM accounts WHERE id = ${id}`);
          await connection`SELECT pg_advisory_unlock(${FLAG_PAUSE_KEY})`;
          held = false;
          return reading;
        });
        expect(profile).toBeUndefined();
        expect(await row(id)).toBeUndefined();
        expect(await tenant(other, (tx) => accountProfileRepository(tx).profile())).toMatchObject({ id: other, hasPassword: true, mfaEnabled: false });
      } finally {
        if (held) {
          await connection`SELECT pg_advisory_unlock(${FLAG_PAUSE_KEY})`;
        }
        connection.release();
      }
    },
  );
});
