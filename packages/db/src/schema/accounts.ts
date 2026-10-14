import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { citext } from "./types.ts";

// `accounts` of doc 05 section 2.1: a global identity, unique by email. The
// MFA columns arrive with the MFA epic, which adds them as nullable columns.
// Row-level security, the column privileges that keep `password_hash` away
// from `slugbase_app` and the policy live in src/sql/060-accounts-sessions.sql,
// which Drizzle cannot express.
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
  ],
);
