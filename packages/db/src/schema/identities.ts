import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea, citext } from "./types.ts";

// `account_identities` and `oidc_login_states` of doc 05 section 2.1. Row-level
// security, the privileges of `slugbase_app` and the system operations that
// write them live in src/sql/170-oidc.sql, which Drizzle cannot express.

/**
 * A provider identity linked to an account. `provider` is the slug of the operator's `OIDC_<SLUG>_*` keys,
 * which fixes the issuer; `subject` is the provider's `sub`. One identity belongs to one account.
 */
export const accountIdentities = pgTable(
  "account_identities",
  {
    id: uuid().primaryKey(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    subject: text().notNull(),
    /** The address the provider asserted when the identity was linked, for display and audit. */
    emailAtLink: citext().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique("account_identities_provider_subject_key").on(table.provider, table.subject),
    check("account_identities_provider_check", sql`length(${table.provider}) BETWEEN 1 AND 64`),
    check("account_identities_subject_check", sql`length(${table.subject}) BETWEEN 1 AND 255`),
    index("account_identities_account_id_idx").on(table.accountId),
  ],
);

/**
 * The state of an OIDC handshake in flight, found by the SHA-256 of the `state` the provider echoes back. The
 * table has forced row-level security and no policy, and `slugbase_app` has no privilege on it: the system
 * operations of src/sql/170-oidc.sql are its only users. The record is deleted when it is consumed, so a
 * state works once; one that is not consumed expires after 10 minutes.
 */
export const oidcLoginStates = pgTable(
  "oidc_login_states",
  {
    /** SHA-256 of the `state` value; the value itself is never stored. */
    stateHash: bytea().primaryKey(),
    provider: text().notNull(),
    intent: text().notNull().default("login"),
    nonce: text().notNull(),
    /** The PKCE code verifier, sealed by the secret box. */
    codeVerifier: bytea().notNull(),
    /** The id of the secret-box key that sealed `codeVerifier`. */
    codeVerifierKeyId: text().notNull(),
    /** A same-origin relative path. */
    returnTo: text().notNull(),
    /** The signed-in account of the `link` and `reauth` intents. */
    linkAccountId: uuid().references(() => accounts.id, { onDelete: "cascade" }),
    /** The invitation the `invite` intent accepts. */
    invitationTokenHash: bytea(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    check("oidc_login_states_state_hash_check", sql`length(${table.stateHash}) = 32`),
    check("oidc_login_states_intent_check", sql`${table.intent} IN ('login', 'link', 'reauth', 'invite')`),
    check("oidc_login_states_return_to_check", sql`${table.returnTo} LIKE '/%' AND length(${table.returnTo}) <= 2048`),
    check("oidc_login_states_link_account_check", sql`(${table.intent} IN ('link', 'reauth')) = (${table.linkAccountId} IS NOT NULL)`),
    check("oidc_login_states_invitation_check", sql`(${table.intent} = 'invite') = (${table.invitationTokenHash} IS NOT NULL)`),
    index("oidc_login_states_expires_at_idx").on(table.expiresAt),
  ],
);
