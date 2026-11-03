import { sql } from "drizzle-orm";
import { bigint, boolean, check, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, citext } from "./types.ts";

// `accounts` of doc 05 section 2.1: a global identity, unique by email.
// Row-level security, the column privileges that keep `password_hash` and the
// `mfa_*` columns away from `slugbase_app` and the policy live in
// src/sql/060-accounts-sessions.sql and src/sql/140-mfa.sql, which Drizzle
// cannot express.
export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey(),
    /** Trimmed and NFKC-normalised by the application, case preserved; `citext` compares it case-insensitively. */
    email: citext().notNull(),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    pendingEmail: citext(),
    displayName: text().notNull(),
    /** An argon2id PHC string; null for an account that signs in through OIDC only. */
    passwordHash: text(),
    /** A session created before this moment is invalid. */
    passwordChangedAt: timestamp({ withTimezone: true }),
    /** When the second factor was confirmed; null while MFA is off, also while an enrolment is pending. */
    mfaEnabledAt: timestamp({ withTimezone: true }),
    /** The TOTP secret sealed by the secret box (pending until `mfaEnabledAt` is set); never readable by `slugbase_app`. */
    mfaSecret: bytea(),
    /** The id of the secret-box key that sealed `mfaSecret`, for rotation. */
    mfaSecretKeyId: text(),
    /** The latest accepted TOTP time step; a code for this step or an earlier one is a replay. */
    mfaLastStep: bigint({ mode: "number" }),
    locale: text().notNull().default("en"),
    theme: text().notNull().default("system"),
    accent: text(),
    defaultBookmarkView: text().notNull().default("grid"),
    singleKeyShortcuts: boolean().notNull().default(true),
    signinAlerts: boolean().notNull().default(true),
    aiOptOut: boolean().notNull().default(false),
    analyticsConsent: text().notNull().default("unset"),
    consentAt: timestamp({ withTimezone: true }),
    onboarding: jsonb().notNull().default(sql`'{}'::jsonb`),
    isInstanceAdmin: boolean().notNull().default(false),
    /** Set by an instance admin: blocks sign-in and invalidates the account's sessions. */
    disabledAt: timestamp({ withTimezone: true }),
    /**
     * `full`, or `export_only` while an instance admin or the composition has left the account a fixed period to take its data out:
     * it can sign in, read and run the exports and nothing else (doc 02 section 2.11). The third mode, disabled, is `disabled_at`.
     * Written by the system operations of src/sql/710-account-access-mode.sql only, which keep the three columns together: `full` with no end
     * date and no end action, or `export_only` with both, the action `disable` or `delete`. The application role holds no privilege on
     * them, read or write; they are read through `sys_account_access_mode`. No CHECK states this: a constraint added to the existing
     * table would have to be added NOT VALID and validated by a later release (doc 05 section 5.2).
     */
    accessMode: text().notNull().default("full"),
    /** When the export-only period ends and its end action runs; set exactly while `access_mode` is `export_only`. */
    exportOnlyUntil: timestamp({ withTimezone: true }),
    /** What happens when the period ends, `disable` or `delete`; set exactly while `access_mode` is `export_only`. */
    exportOnlyEndAction: text(),
    lastSignInAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("accounts_email_key").on(table.email),
    check("accounts_display_name_check", sql`length(${table.displayName}) BETWEEN 1 AND 100`),
    check("accounts_locale_check", sql`${table.locale} IN ('en', 'de')`),
    check("accounts_theme_check", sql`${table.theme} IN ('light', 'dark', 'system')`),
    check("accounts_default_bookmark_view_check", sql`${table.defaultBookmarkView} IN ('grid', 'table')`),
    check("accounts_analytics_consent_check", sql`${table.analyticsConsent} IN ('unset', 'granted', 'denied')`),
    check("accounts_mfa_secret_check", sql`(${table.mfaSecret} IS NULL) = (${table.mfaSecretKeyId} IS NULL)`),
    check("accounts_mfa_enabled_check", sql`${table.mfaEnabledAt} IS NULL OR ${table.mfaSecret} IS NOT NULL`),
  ],
);
