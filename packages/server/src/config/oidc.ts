import type { IdentityProviderConfig } from "@slugbase/core";
import { z } from "zod";
import { envBoolean } from "./env-boolean.ts";
import { bareHost } from "./fields.ts";
import { envFragment, type EnvironmentVariables, type RefineContext } from "./fragment.ts";

// The OIDC providers of the operator (doc 02 section 2.8). Each is configured by `OIDC_<SLUG>_*` keys,
// where <SLUG> is chosen by the operator, so the keys cannot be listed in a fixed shape: the fragment reads
// them from the whole environment. A provider exists as soon as one of its keys has a value; it is then
// enabled unless `OIDC_<SLUG>_ENABLED` says otherwise, and an enabled provider that lacks a required key
// refuses the start, naming the key. Messages name keys only, never a value (T7).

export const OIDC_REQUIRED_FIELDS = ["CLIENT_ID", "CLIENT_SECRET", "ISSUER_URL"] as const;
export const OIDC_OPTIONAL_FIELDS = ["NAME", "SCOPES", "ENABLED", "AUTO_CREATE", "ALLOWED_DOMAINS", "ALLOWED_PRIVATE_HOST", "ENTRA_MULTI_TENANT", "ENTRA_TENANTS", "ENTRA_VERIFIED_DOMAIN"] as const;
const FIELDS: readonly string[] = [...OIDC_REQUIRED_FIELDS, ...OIDC_OPTIONAL_FIELDS];

// <SLUG> is upper-case letters and digits in groups separated by single underscores.
const KEY = new RegExp(`^OIDC_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(${FIELDS.join("|")})$`);

export const DEFAULT_OIDC_SCOPES: readonly string[] = ["openid", "email", "profile"];

// A scope is a token of visible ASCII without quote and backslash (RFC 6749 section 3.3).
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`);

type RawProvider = Map<string, string>;

function group(env: EnvironmentVariables): Map<string, RawProvider> {
  const providers = new Map<string, RawProvider>();
  for (const [key, value] of Object.entries(env)) {
    const match = KEY.exec(key);
    const slug = match?.[1];
    const field = match?.[2];
    if (slug === undefined || field === undefined || value === undefined || value === "") {
      continue;
    }
    const raw = providers.get(slug) ?? new Map<string, string>();
    raw.set(field, value);
    providers.set(slug, raw);
  }
  return providers;
}

function check<T>(key: string, schema: z.ZodType<T>, value: string | undefined, context: RefineContext): T | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    context.issue(key, result.error.issues[0]?.message ?? "is not valid");
    return undefined;
  }
  return result.data;
}

function issuerUrl(production: boolean) {
  return z.string().refine(
    (value) => {
      if (!URL.canParse(value)) {
        return false;
      }
      const url = new URL(value);
      return (
        (url.protocol === "https:" || (!production && url.protocol === "http:")) &&
        url.hostname !== "" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        !/[?#]/.test(value)
      );
    },
    {
      error: production
        ? "must be an https URL without credentials, query or fragment"
        : "must be an http or https URL without credentials, query or fragment",
    },
  );
}

const displayName = z
  .string()
  .trim()
  .refine((value) => /^[^\p{Cc}]{1,64}$/u.test(value), { error: "must be 1 to 64 characters with no control character" });

const scopes = z
  .string()
  .transform((value) => [...new Set(value.split(/[\s,]+/).filter((token) => token !== ""))])
  .refine((tokens) => tokens.every((token) => SCOPE_TOKEN.test(token)), { error: "must be scope names separated by spaces or commas" })
  .refine((tokens) => tokens.includes("openid"), { error: "must include the openid scope" });

const domains = z
  .string()
  .transform((value) => value.split(",").map((domain) => domain.trim().toLowerCase()))
  .refine((list) => list.every((domain) => DOMAIN.test(domain)), { error: "must be comma-separated email domains such as example.com" });

// The multi-tenant endpoints of Microsoft Entra ID (Q121), on any host so that a national cloud works. The OIDC adapter
// reads the same shape (`packages/adapters/src/identity/oidc.ts`) and leaves a provider out whose issuer does not match it.
const ENTRA_MULTI_TENANT_ISSUER = /^https?:\/\/[^/?#]+\/(?:common|organizations)\/v2\.0$/;
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tenants = z
  .string()
  .transform((value) => [...new Set(value.split(",").map((tenant) => tenant.trim().toLowerCase()))])
  .refine((list) => list.every((tenant) => TENANT_ID.test(tenant)), { error: "must be comma-separated tenant ids, each a GUID" });

/** The Entra opt-ins of a provider, set only where they differ from the default, so a provider that sets none is unchanged. */
type EntraSettings = Pick<IdentityProviderConfig, "entraMultiTenant" | "entraTenants" | "entraVerifiedDomain">;

// `undefined` when a key was refused, which is already reported. The tenant list is valid only with the multi-tenant rule, and that
// rule only with an issuer that is one of Entra's multi-tenant endpoints.
function entraSettings(key: (field: string) => string, raw: RawProvider, issuer: string | undefined, context: RefineContext): EntraSettings | undefined {
  const multiTenant = check(key("ENTRA_MULTI_TENANT"), envBoolean().default(false), raw.get("ENTRA_MULTI_TENANT"), context);
  const verifiedDomain = check(key("ENTRA_VERIFIED_DOMAIN"), envBoolean().default(false), raw.get("ENTRA_VERIFIED_DOMAIN"), context);
  let tenantList: readonly string[] | undefined;
  if (multiTenant === true) {
    if (issuer !== undefined && !ENTRA_MULTI_TENANT_ISSUER.test(issuer)) {
      context.issue(key("ISSUER_URL"), `must be a Microsoft Entra ID common or organizations v2.0 endpoint when ${key("ENTRA_MULTI_TENANT")} is on`);
      return undefined;
    }
    tenantList = check(key("ENTRA_TENANTS"), tenants.optional(), raw.get("ENTRA_TENANTS"), context);
    if (raw.has("ENTRA_TENANTS") && tenantList === undefined) {
      return undefined;
    }
  } else if (multiTenant === false && raw.has("ENTRA_TENANTS")) {
    context.issue(key("ENTRA_TENANTS"), `is valid only with ${key("ENTRA_MULTI_TENANT")} on`);
    return undefined;
  }
  if (multiTenant === undefined || verifiedDomain === undefined) {
    return undefined;
  }
  return {
    ...(multiTenant ? { entraMultiTenant: true } : {}),
    ...(tenantList === undefined ? {} : { entraTenants: tenantList }),
    ...(verifiedDomain ? { entraVerifiedDomain: true } : {}),
  };
}

/** An enabled provider and, when the operator named its issuer host as allowed on a private address, the origin of its issuer (Q120). */
interface ParsedProvider {
  readonly config: IdentityProviderConfig;
  readonly privateOrigin?: string;
}

// `OIDC_<SLUG>_ALLOWED_PRIVATE_HOST` is one bare host that must be the host of the same provider's issuer, so a changed
// `ISSUER_URL` never keeps an allowance meant for the old host. The issuer's origin, not the host alone, is what the egress
// adapter exempts.
function privateOrigin(key: string, raw: RawProvider, issuer: string | undefined, context: RefineContext): string | undefined {
  const host = check(key, bareHost().optional(), raw.get("ALLOWED_PRIVATE_HOST"), context);
  if (host === undefined || issuer === undefined) {
    return undefined;
  }
  const url = new URL(issuer);
  if (url.hostname !== host) {
    context.issue(key, "must be the host of the provider's ISSUER_URL");
    return undefined;
  }
  return url.origin;
}

function provider(slug: string, raw: RawProvider, context: RefineContext): ParsedProvider | undefined {
  const key = (field: string): string => `OIDC_${slug}_${field}`;
  const enabled = check(key("ENABLED"), envBoolean().default(true), raw.get("ENABLED"), context);
  if (enabled !== true) {
    return undefined;
  }
  const missing = OIDC_REQUIRED_FIELDS.filter((field) => !raw.has(field));
  for (const field of missing) {
    context.issue(key(field), `is required because the OIDC provider ${slug} is enabled`);
  }
  const clientId = raw.get("CLIENT_ID");
  const clientSecret = raw.get("CLIENT_SECRET");
  const issuer = raw.has("ISSUER_URL") ? check(key("ISSUER_URL"), issuerUrl(context.production), raw.get("ISSUER_URL"), context) : undefined;
  const name = check(key("NAME"), displayName.optional(), raw.get("NAME"), context);
  const scopeList = check(key("SCOPES"), scopes.default([...DEFAULT_OIDC_SCOPES]), raw.get("SCOPES"), context);
  const autoCreate = check(key("AUTO_CREATE"), envBoolean().default(false), raw.get("AUTO_CREATE"), context);
  const allowedDomains = check(key("ALLOWED_DOMAINS"), domains.default([]), raw.get("ALLOWED_DOMAINS"), context);
  const allowedOrigin = privateOrigin(key("ALLOWED_PRIVATE_HOST"), raw, issuer, context);
  const hostRefused = raw.has("ALLOWED_PRIVATE_HOST") && allowedOrigin === undefined;
  const entra = entraSettings(key, raw, issuer, context);
  if (
    missing.length > 0 ||
    clientId === undefined ||
    clientSecret === undefined ||
    issuer === undefined ||
    scopeList === undefined ||
    autoCreate === undefined ||
    allowedDomains === undefined ||
    entra === undefined ||
    hostRefused
  ) {
    return undefined;
  }
  const publicSlug = slug.toLowerCase().replaceAll("_", "-");
  return {
    config: {
      slug: publicSlug,
      name: name ?? publicSlug,
      clientId,
      clientSecret,
      issuerUrl: issuer,
      scopes: scopeList,
      autoCreate,
      allowedDomains,
      ...entra,
    },
    ...(allowedOrigin === undefined ? {} : { privateOrigin: allowedOrigin }),
  };
}

function parseProviders(env: EnvironmentVariables, context: RefineContext): readonly ParsedProvider[] {
  return [...group(env)]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([slug, raw]) => {
      const parsed = provider(slug, raw, context);
      return parsed === undefined ? [] : [parsed];
    })
    .sort((left, right) => (left.config.slug < right.config.slug ? -1 : left.config.slug > right.config.slug ? 1 : 0));
}

/** Every enabled provider the `OIDC_<SLUG>_*` keys of `env` configure, in slug order; problems go to `context`. */
export function parseOidcProviders(env: EnvironmentVariables, context: RefineContext): readonly IdentityProviderConfig[] {
  return parseProviders(env, context).map(({ config }) => config);
}

/**
 * The OIDC providers (doc 02 section 2.8), for the server. No key set means no provider and the sign-in
 * page offers none; the sign-in handshake is served by the server alone, so the worker does not read them.
 * `OIDC_PRIVATE_ORIGINS` holds the issuer origin of each provider whose `OIDC_<SLUG>_ALLOWED_PRIVATE_HOST` the
 * configuration accepted (Q120), which the composition hands to the OIDC adapter's egress instance and to nothing else.
 */
export const oidcFragment = envFragment({
  shape: {},
  collect: (
    env,
    context,
  ): { readonly OIDC_PROVIDERS: readonly IdentityProviderConfig[]; readonly OIDC_PRIVATE_ORIGINS: readonly string[] } => {
    const parsed = parseProviders(env, context);
    return {
      OIDC_PROVIDERS: parsed.map(({ config }) => config),
      OIDC_PRIVATE_ORIGINS: [...new Set(parsed.flatMap(({ privateOrigin: origin }) => (origin === undefined ? [] : [origin])))],
    };
  },
});
