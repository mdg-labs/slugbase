import { eq, sql } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { tenantHandle, type TenantTx } from "../tenant.ts";

// The signed-in account's own profile (doc 04 section 10.3): the columns
// `slugbase_app` may read of its own row, and whether the account has a
// password and whether its second factor is on, which the column privileges keep
// the application from reading. Nothing secret is selected.

export const ACCENT_PRESETS = ["periwinkle", "violet", "rose", "amber", "green", "teal"] as const;
export type AccentPreset = (typeof ACCENT_PRESETS)[number];

/** The checklist state of doc 02 section 9.3 that is stored; the other checklist items are derived from data. */
export interface Onboarding {
  readonly browserSetupDone: boolean;
  readonly importDone: boolean;
  readonly checklistDismissed: boolean;
}

export type AnalyticsConsent = "unset" | "granted" | "denied";

export interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: "en" | "de";
  readonly theme: "light" | "dark" | "system";
  readonly accent: AccentPreset | null;
  readonly defaultBookmarkView: "grid" | "table";
  readonly singleKeyShortcuts: boolean;
  readonly aiOptOut: boolean;
  readonly analyticsConsent: AnalyticsConsent;
  readonly onboarding: Onboarding;
  readonly emailVerified: boolean;
  readonly hasPassword: boolean;
  readonly mfaEnabled: boolean;
}

// The columns hold these values by their CHECK constraints (doc 05 section 2.1); a value outside them is a schema drift.
function oneOf<T extends string>(column: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`accounts.${column} holds a value outside ${allowed.join(", ")}`);
  }
  return found;
}

/**
 * The columns of the profile an account changes itself; a field left out keeps its value. A choice of
 * `analyticsConsent` is stored with the time it was made (`consent_at`), and `unset` clears that time. The
 * `onboarding` keys given are merged into the stored state; the others keep their value.
 */
export interface AccountProfileChanges {
  readonly displayName?: string;
  readonly locale?: "en" | "de";
  readonly theme?: "light" | "dark" | "system";
  readonly accent?: AccentPreset;
  readonly defaultBookmarkView?: "grid" | "table";
  readonly singleKeyShortcuts?: boolean;
  readonly aiOptOut?: boolean;
  readonly analyticsConsent?: AnalyticsConsent;
  readonly onboarding?: Partial<Onboarding>;
}

function onboardingOf(stored: unknown): Onboarding {
  const keys = typeof stored === "object" && stored !== null ? stored : {};
  const flag = (key: keyof Onboarding): boolean => Reflect.get(keys, key) === true;
  return { browserSetupDone: flag("browserSetupDone"), importDone: flag("importDone"), checklistDismissed: flag("checklistDismissed") };
}

export interface AccountProfileRepository {
  /** The account of the transaction; undefined when no such row is visible. Works in an account-level transaction. */
  profile(): Promise<AccountProfile | undefined>;
  /**
   * Writes the changes to the account of the transaction and answers its profile afterwards; undefined when no
   * such row is visible. The row is the one `app.account_id` names, never one the caller names, and the
   * application role holds the update privilege on the columns of these changes only. The changes are one
   * statement, so all of them apply or none does. No change writes nothing.
   */
  updateProfile(changes: AccountProfileChanges): Promise<AccountProfile | undefined>;
}

export function accountProfileRepository(tx: TenantTx): AccountProfileRepository {
  const repository: AccountProfileRepository = {
    async profile() {
      const handle = tenantHandle(tx);
      const [row] = await handle
        .select({
          id: accounts.id,
          email: accounts.email,
          emailVerifiedAt: accounts.emailVerifiedAt,
          displayName: accounts.displayName,
          locale: accounts.locale,
          theme: accounts.theme,
          accent: accounts.accent,
          defaultBookmarkView: accounts.defaultBookmarkView,
          singleKeyShortcuts: accounts.singleKeyShortcuts,
          aiOptOut: accounts.aiOptOut,
          analyticsConsent: accounts.analyticsConsent,
          onboarding: accounts.onboarding,
        })
        .from(accounts)
        .where(eq(accounts.id, tx.accountId));
      if (row === undefined) {
        return undefined;
      }
      const flag = await handle.execute<{ has_password: boolean | null }>(sql`SELECT public.sys_account_has_password() AS has_password`);
      const hasPassword = flag[0]?.has_password;
      if (typeof hasPassword !== "boolean") {
        throw new Error("sys_account_has_password did not answer for a visible account");
      }
      const mfa = await handle.execute<{ mfa_enabled: boolean | null }>(sql`SELECT public.sys_account_mfa_enabled() AS mfa_enabled`);
      const mfaEnabled = mfa[0]?.mfa_enabled;
      if (typeof mfaEnabled !== "boolean") {
        throw new Error("sys_account_mfa_enabled did not answer for a visible account");
      }
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        locale: oneOf("locale", row.locale, ["en", "de"]),
        theme: oneOf("theme", row.theme, ["light", "dark", "system"]),
        accent: row.accent === null ? null : oneOf("accent", row.accent, ACCENT_PRESETS),
        defaultBookmarkView: oneOf("default_bookmark_view", row.defaultBookmarkView, ["grid", "table"]),
        singleKeyShortcuts: row.singleKeyShortcuts,
        aiOptOut: row.aiOptOut,
        analyticsConsent: oneOf("analytics_consent", row.analyticsConsent, ["unset", "granted", "denied"]),
        onboarding: onboardingOf(row.onboarding),
        emailVerified: row.emailVerifiedAt !== null,
        hasPassword,
        mfaEnabled,
      };
    },
    async updateProfile(changes) {
      const { onboarding, analyticsConsent, ...columns } = changes;
      const set = {
        ...columns,
        ...(analyticsConsent === undefined
          ? {}
          : { analyticsConsent, consentAt: analyticsConsent === "unset" ? null : sql`now()` }),
        ...(onboarding === undefined || Object.keys(onboarding).length === 0
          ? {}
          : { onboarding: sql`${accounts.onboarding} || ${JSON.stringify(onboarding)}::jsonb` }),
      };
      if (Object.keys(set).length > 0) {
        const updated = await tenantHandle(tx).update(accounts).set(set).where(eq(accounts.id, tx.accountId)).returning({ id: accounts.id });
        if (updated.length === 0) {
          return undefined;
        }
      }
      return repository.profile();
    },
  };
  return repository;
}
