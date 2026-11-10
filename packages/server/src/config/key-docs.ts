import { LOG_LEVELS, NODE_ENVS, SMTP_SECURITIES } from "./fragments.ts";
import type { MergedShape } from "./fragment.ts";
import { DEFAULT_OIDC_SCOPES, OIDC_OPTIONAL_FIELDS, OIDC_REQUIRED_FIELDS } from "./oidc.ts";
import { RATE_LIMIT_DEFAULTS, rateLimitKey, type RateLimitBucket, type RateLimitKey, type RateScope } from "./rate-limits.ts";
import type { migrateFragments, serverFragments, workerFragments } from "./schemas.ts";

// What the operator reads about each environment key: the group it belongs to, its type, a one-line
// description and, where the schema cannot say it, when it is required and what it defaults to. The
// reference `docs/self-hosting/environment.md` is generated from the schemas and from this table
// (`pnpm env:docs`). The generator and the tests import this file by its path; it is no part of the
// package's API. A key a schema declares without an entry here fails the generator, and the type and the
// "required" claim of an entry are held against the schema by a test.
//
// A description is one line of Markdown. It never holds a secret or a value that looks like one: an
// example is a placeholder such as `<your secret>`.

export const KEY_GROUPS = [
  "runtime",
  "http",
  "database",
  "secrets",
  "accounts",
  "retention",
  "rate-limits",
  "observability",
  "mail",
  "ai",
] as const;

export type KeyGroup = (typeof KEY_GROUPS)[number];

/** How a value is written. The test of this table parses each kind against the schema of its key. */
export type KeyType =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "enum"; readonly options: readonly string[] }
  | { readonly kind: "rate" }
  | { readonly kind: "text"; readonly label: string };

export interface KeyDoc {
  readonly group: KeyGroup;
  readonly type: KeyType;
  readonly description: string;
  /** Replaces the computed "Yes" or "No" when the schema alone does not say when the key is required. */
  readonly requiredWhen?: string;
  /** Replaces the default of the schema, for a key whose schema has none because the composition decides it. */
  readonly defaultText?: string;
}

type SchemaKey =
  | keyof MergedShape<typeof serverFragments>
  | keyof MergedShape<typeof workerFragments>
  | keyof MergedShape<typeof migrateFragments>;

const HAND_WRITTEN = {
  NODE_ENV: {
    group: "runtime",
    type: { kind: "enum", options: NODE_ENVS },
    description: "The environment. `production` applies the refusals of a production start; `compose.yml` sets it to `production`.",
  },
  LOG_LEVEL: {
    group: "runtime",
    type: { kind: "enum", options: LOG_LEVELS },
    description: "The lowest level the process logs.",
  },
  APP_ORIGIN: {
    group: "http",
    type: { kind: "text", label: "origin URL" },
    description:
      "The origin members open in the browser, such as `https://bookmarks.example.com`, with no path. It is used in links in mail and in cookie names. In production it must use `https`.",
  },
  PORT: {
    group: "http",
    type: { kind: "integer", min: 1, max: 65535 },
    description: "The port the server listens on.",
  },
  TRUSTED_PROXY_HOPS: {
    group: "http",
    type: { kind: "integer", min: 0, max: 32 },
    description:
      "How many reverse proxies in front of the server write `X-Forwarded-For`. Behind one proxy set it to `1`. At `0` every client shares the proxy's address; a value above the real number lets a client choose its own address.",
  },
  API_DOCS_ENABLED: {
    group: "http",
    type: { kind: "boolean" },
    description: "Whether the server serves the API reference.",
  },
  DOCS_BASE_URL: {
    group: "http",
    type: { kind: "text", label: "http or https URL" },
    description: "The address the in-app links to the documentation point to.",
  },
  DATABASE_URL: {
    group: "database",
    type: { kind: "text", label: "PostgreSQL URL" },
    description:
      "The connection of the `slugbase_app` role, for the server and the worker, such as `postgres://slugbase_app:<your password>@db:5432/slugbase`. Production refuses the development password.",
  },
  DATABASE_MIGRATE_URL: {
    group: "database",
    type: { kind: "text", label: "PostgreSQL URL" },
    description:
      "The connection of the `slugbase_migrator` role, which applies the migrations. The server needs it only to migrate on start; the worker never reads it.",
    requiredWhen: "Always for `migrate`; for the server while `MIGRATE_ON_START` is `true`",
  },
  MIGRATE_ON_START: {
    group: "database",
    type: { kind: "boolean" },
    description:
      "Whether the server applies pending migrations before it starts. Set it to `false` when a deploy step runs `migrate` instead; the server then needs no migrator connection.",
  },
  SLUGBASE_ALLOW_OWNER_CONNECTION: {
    group: "database",
    type: { kind: "boolean" },
    description:
      "Whether a `DATABASE_URL` role that is a superuser, owns the database or has `BYPASSRLS` may start in production, with a warning. `false` refuses each of them.",
  },
  SESSION_SECRET: {
    group: "secrets",
    type: { kind: "text", label: "text, at least 32 characters in production" },
    description: "The secret that signs sessions. Generate a long random value, such as `<your secret>`, and keep it only in `.env`.",
  },
  ENCRYPTION_KEY: {
    group: "secrets",
    type: { kind: "text", label: "base64 of 32 bytes" },
    description:
      "The key that seals stored secrets. Generate 32 random bytes and write them as base64, such as `<your key>`. Production refuses the development key.",
  },
  ENCRYPTION_KEY_ID: {
    group: "secrets",
    type: { kind: "text", label: "1 to 64 letters, digits, dots, hyphens or underscores" },
    description: "A name for the current `ENCRYPTION_KEY`, kept with every value it seals so that a rotation finds the right key.",
  },
  ENCRYPTION_KEY_PREVIOUS: {
    group: "secrets",
    type: { kind: "text", label: "comma-separated `id:key` pairs" },
    description:
      "After a key rotation, the old keys as `<id>:<base64 key>` pairs, such as `<old id>:<old key>`. They only open values sealed before the rotation. An id must not repeat.",
  },
  SETUP_ENABLED: {
    group: "accounts",
    type: { kind: "boolean" },
    description: "Whether first-run setup may create the first account. `false` closes it for the deployment.",
  },
  SETUP_TOKEN_REQUIRED: {
    group: "accounts",
    type: { kind: "boolean" },
    description: "Whether first-run setup needs the one-time token the server prints to its log at each start while no account exists.",
  },
  PUBLIC_REGISTRATION: {
    group: "accounts",
    type: { kind: "boolean" },
    description: "Whether a visitor can create an account. Unset, the build you run decides.",
    defaultText: "`false` (the Community Edition opens no registration)",
  },
  EMAIL_VERIFICATION_REQUIRED: {
    group: "accounts",
    type: { kind: "boolean" },
    description:
      "Whether an account must verify its address before it can sign in. It needs the mail keys: without mail, registration answers `503`. Unset, the build you run decides.",
    defaultText: "`false` (the Community Edition does not require it)",
  },
  BREACHED_PASSWORD_CHECK: {
    group: "accounts",
    type: { kind: "boolean" },
    description:
      "Whether a new password is refused when it is in the breached-password dataset shipped with the image. The lookup is local; nothing is sent. The length rules always apply.",
  },
  TOTP_ISSUER: {
    group: "accounts",
    type: { kind: "text", label: "1 to 64 characters, no colon" },
    description:
      "The name an authenticator app lists an account under. Unset, it is `SlugBase` followed by the host name of `APP_ORIGIN`, without its port.",
  },
  AUDIT_RETENTION_DAYS: {
    group: "retention",
    type: { kind: "integer", min: 0, max: 36_500 },
    description:
      "How many days audit events are kept before the hourly retention purge deletes them. `0` keeps them forever. The event that records the completed first-run setup is kept.",
  },
  METRICS_PORT: {
    group: "observability",
    type: { kind: "integer", min: 1, max: 65535 },
    description: "The port of the internal listener for `/metrics`. Unset opens no listener. Keep it off the public network. It must differ from `PORT`.",
  },
  ERROR_REPORT_DSN: {
    group: "observability",
    type: { kind: "text", label: "Sentry-protocol DSN" },
    description:
      "The DSN of your own error tracker, such as `<your DSN>`. Unset reports nothing beyond the log. Personal data is scrubbed before anything is sent.",
  },
  SMTP_HOST: {
    group: "mail",
    type: { kind: "text", label: "host name or IP address" },
    description: "The host of the SMTP relay, with no scheme, port or path.",
    requiredWhen: "Together with `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_FROM`",
  },
  SMTP_PORT: {
    group: "mail",
    type: { kind: "integer", min: 1, max: 65535 },
    description: "The port of the relay, usually 465 for `tls` and 587 for `starttls`.",
    requiredWhen: "Together with `SMTP_HOST`, `SMTP_SECURITY` and `SMTP_FROM`",
  },
  SMTP_SECURITY: {
    group: "mail",
    type: { kind: "enum", options: SMTP_SECURITIES },
    description: "How SlugBase connects: `tls` from the first byte, `starttls` after a plain start, or `none` in plain text. The relay's certificate is verified.",
    requiredWhen: "Together with `SMTP_HOST`, `SMTP_PORT` and `SMTP_FROM`",
  },
  SMTP_USER: {
    group: "mail",
    type: { kind: "text", label: "text" },
    description: "The user name for the relay. Leave it and `SMTP_PASS` unset for a relay without authentication.",
    requiredWhen: "Together with `SMTP_PASS`",
  },
  SMTP_PASS: {
    group: "mail",
    type: { kind: "text", label: "text" },
    description: "The password for the relay, such as `<your password>`. Set it only in `.env`.",
    requiredWhen: "Together with `SMTP_USER`",
  },
  SMTP_FROM: {
    group: "mail",
    type: { kind: "text", label: "address, or name and address" },
    description: "The sender of every message: an address, or a name and address such as `SlugBase <slugbase@example.com>`.",
    requiredWhen: "Together with `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURITY`",
  },
  AI_BASE_URL: {
    group: "ai",
    type: { kind: "text", label: "http or https URL" },
    description:
      "The base URL the endpoint documents, such as one that ends in `/v1`. SlugBase adds `/chat/completions`. It has no credentials, query or fragment.",
    requiredWhen: "Together with `AI_MODEL` and `AI_PROVIDER_NAME`",
  },
  AI_API_KEY: {
    group: "ai",
    type: { kind: "text", label: "up to 512 visible characters" },
    description:
      "The credential for the endpoint, sent as a bearer token, such as `<your API key>`. Leave it unset for an endpoint that takes none. Set it only in `.env`.",
  },
  AI_MODEL: {
    group: "ai",
    type: { kind: "text", label: "up to 200 visible characters" },
    description: "The name of the model to ask, with no space.",
    requiredWhen: "Together with `AI_BASE_URL` and `AI_PROVIDER_NAME`",
  },
  AI_PROVIDER_NAME: {
    group: "ai",
    type: { kind: "text", label: "1 to 64 characters" },
    description: "The name members see when SlugBase says who processes a request.",
    requiredWhen: "Together with `AI_BASE_URL` and `AI_MODEL`",
  },
  AI_ALLOWED_PRIVATE_HOST: {
    group: "ai",
    type: { kind: "text", label: "one bare host" },
    description:
      "The one host of `AI_BASE_URL` that may be on a private address, and the only host that may use plain `http`. It has no scheme, port, path, wildcard or range.",
  },
} as const satisfies Record<Exclude<SchemaKey, RateLimitKey>, KeyDoc>;

// What each bucket of the rate-limit registry limits, and what each scope counts.

const BUCKET_LIMITS: Readonly<Record<RateLimitBucket, string>> = {
  login: "Signing in",
  mfa: "Entering a second-factor code",
  register: "Creating an account by public registration",
  reset: "Asking for a password reset",
  token_redeem: "Using a one-time link from an email, such as to verify an address or accept an invitation",
  token_create: "Creating an API token",
  setup: "First-run setup",
  go: "Opening a slug link, choosing between bookmarks that share a slug, slug suggestions and recording an open",
  read: "Reading data through the API",
  write: "Changing data through the API",
  bulk: "Bulk actions on bookmarks, imports and exports",
  fetch: "Fetching a page's title and description while a bookmark is added, and fetching site icons that are not stored yet",
  ai: "AI suggestions",
  public: "Pages that need no sign-in",
};

const SCOPE_COUNTS: Readonly<Record<RateScope, string>> = {
  ip: "each address",
  account: "each account",
  workspace: "each workspace",
  email: "each email address",
};

function rateLimitDocs(): Readonly<Record<string, KeyDoc>> {
  const docs: Record<string, KeyDoc> = {};
  for (const [bucket, scopes] of Object.entries(RATE_LIMIT_DEFAULTS)) {
    for (const scope of Object.keys(scopes) as RateScope[]) {
      docs[rateLimitKey(bucket, scope)] = {
        group: "rate-limits",
        type: { kind: "rate" },
        description: `${BUCKET_LIMITS[bucket as RateLimitBucket]}, for ${SCOPE_COUNTS[scope]}.`,
      };
    }
  }
  return docs;
}

/** The documentation of every key a process schema declares, by key. */
export const KEY_DOCS: Readonly<Record<string, KeyDoc>> = { ...HAND_WRITTEN, ...rateLimitDocs() };

/**
 * A key of the `OIDC_<SLUG>_*` family. `<SLUG>` is the operator's name for a provider, so these keys are in no
 * schema shape; the OIDC fragment reads them from the whole environment.
 */
export interface OidcKeyDoc {
  readonly field: string;
  readonly type: KeyType;
  readonly description: string;
  readonly required: boolean;
  /** The default, as written on the page; `undefined` for a required field. */
  readonly defaultText?: string;
}

const OIDC_DOCS = {
  CLIENT_ID: { type: { kind: "text", label: "text" }, description: "The client id registered at the provider." },
  CLIENT_SECRET: {
    type: { kind: "text", label: "text" },
    description: "The client secret registered at the provider, such as `<your client secret>`. Set it only in the file the server reads.",
  },
  ISSUER_URL: {
    type: { kind: "text", label: "URL" },
    description:
      "The issuer, which the provider's discovery document must name exactly. It uses `https` in production and has no credentials, query or fragment.",
  },
  NAME: { type: { kind: "text", label: "1 to 64 characters" }, description: "The name on the provider's button.", defaultText: "The slug" },
  SCOPES: {
    type: { kind: "text", label: "scope names separated by spaces or commas" },
    description: "The scopes to ask for. They must include `openid`.",
    defaultText: `\`${DEFAULT_OIDC_SCOPES.join(" ")}\``,
  },
  ENABLED: { type: { kind: "boolean" }, description: "Whether the provider is on.", defaultText: "`true`" },
  AUTO_CREATE: {
    type: { kind: "boolean" },
    description: "Whether a sign-in through the provider creates an account for an address that has none.",
    defaultText: "`false`",
  },
  ALLOWED_DOMAINS: {
    type: { kind: "text", label: "comma-separated email domains" },
    description: "The email domains an automatically created account may have.",
    defaultText: "Any domain",
  },
  ALLOWED_PRIVATE_HOST: {
    type: { kind: "text", label: "one bare host" },
    description:
      "The host of `OIDC_<SLUG>_ISSUER_URL`, when the provider is on a private address. SlugBase then reaches that one origin, and no other, on a loopback, private, CGNAT or unique-local address. It has no scheme, port, path, wildcard or range, and the issuer still uses `https` in production.",
    defaultText: "None: the provider must be on a public address",
  },
} as const satisfies Record<(typeof OIDC_REQUIRED_FIELDS)[number] | (typeof OIDC_OPTIONAL_FIELDS)[number], Omit<OidcKeyDoc, "field" | "required">>;

/** The `OIDC_<SLUG>_*` keys in the order the page lists them: the required ones first. */
export function oidcKeyDocs(): readonly OidcKeyDoc[] {
  const doc = (field: keyof typeof OIDC_DOCS, required: boolean): OidcKeyDoc => ({ field, required, ...OIDC_DOCS[field] });
  return [
    ...OIDC_REQUIRED_FIELDS.map((field) => doc(field, true)),
    ...OIDC_OPTIONAL_FIELDS.map((field) => doc(field, false)),
  ];
}
