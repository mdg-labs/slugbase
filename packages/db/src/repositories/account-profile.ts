import { eq, sql } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { tenantHandle, type TenantTx } from "../tenant.ts";

// The signed-in account's own profile (doc 04 section 10.3): the columns
// `slugbase_app` may read of its own row, and whether the account has a
// password, which the column privileges keep the application from reading.
// Nothing secret is selected.

export interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: "en" | "de";
  readonly theme: "light" | "dark" | "system";
  readonly accent: string | null;
  readonly defaultBookmarkView: "grid" | "table";
  readonly aiOptOut: boolean;
  readonly emailVerified: boolean;
  readonly hasPassword: boolean;
}

// The columns hold these values by their CHECK constraints (doc 05 section 2.1); a value outside them is a schema drift.
function oneOf<T extends string>(column: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`accounts.${column} holds a value outside ${allowed.join(", ")}`);
  }
  return found;
}

/** The columns of the profile an account changes itself; a field left out keeps its value. */
export interface AccountProfileChanges {
  readonly displayName?: string;
  readonly locale?: "en" | "de";
}

export interface AccountProfileRepository {
  /** The account of the transaction; undefined when no such row is visible. Works in an account-level transaction. */
  profile(): Promise<AccountProfile | undefined>;
  /**
   * Writes the changes to the account of the transaction and answers its profile afterwards; undefined when no
   * such row is visible. The row is the one `app.account_id` names, never one the caller names, and the
   * application role holds the update privilege on these two columns only. No change writes nothing.
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
          aiOptOut: accounts.aiOptOut,
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
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        locale: oneOf("locale", row.locale, ["en", "de"]),
        theme: oneOf("theme", row.theme, ["light", "dark", "system"]),
        accent: row.accent,
        defaultBookmarkView: oneOf("default_bookmark_view", row.defaultBookmarkView, ["grid", "table"]),
        aiOptOut: row.aiOptOut,
        emailVerified: row.emailVerifiedAt !== null,
        hasPassword,
      };
    },
    async updateProfile({ displayName, locale }) {
      if (displayName !== undefined || locale !== undefined) {
        const updated = await tenantHandle(tx)
          .update(accounts)
          .set({
            ...(displayName === undefined ? {} : { displayName }),
            ...(locale === undefined ? {} : { locale }),
          })
          .where(eq(accounts.id, tx.accountId))
          .returning({ id: accounts.id });
        if (updated.length === 0) {
          return undefined;
        }
      }
      return repository.profile();
    },
  };
  return repository;
}
