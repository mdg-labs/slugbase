import { z } from "zod";

const providerIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Provider slug must be a URL-safe slug");

export const oidcEnvProviderSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().min(1).default("openid email profile"),
  enabled: z.boolean().default(true),
});

export type OidcEnvProvider = z.infer<typeof oidcEnvProviderSchema>;

const oidcEnvProvidersArraySchema = z
  .array(oidcEnvProviderSchema)
  .superRefine((providers, ctx) => {
    const ids = new Set<string>();
    for (const [index, provider] of providers.entries()) {
      if (ids.has(provider.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate provider slug: ${provider.id}`,
          path: [index, "id"],
        });
      }
      ids.add(provider.id);
    }
  });

const OIDC_ENV_KEY_PATTERN =
  /^OIDC_([A-Za-z0-9][A-Za-z0-9-]*)_(CLIENT_ID|CLIENT_SECRET|ISSUER_URL|NAME|SCOPES|ENABLED)$/;

type OidcEnvField =
  | "CLIENT_ID"
  | "CLIENT_SECRET"
  | "ISSUER_URL"
  | "NAME"
  | "SCOPES"
  | "ENABLED";

interface OidcEnvBucket {
  clientId?: string;
  clientSecret?: string;
  issuerUrl?: string;
  name?: string;
  scopes?: string;
  enabled?: string;
}

function parseEnabledFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Discovers OIDC providers from per-provider deployment env vars (spec §11.3, §15).
 * Pattern: `OIDC_{SLUG}_CLIENT_ID`, `OIDC_{SLUG}_CLIENT_SECRET`, `OIDC_{SLUG}_ISSUER_URL`, etc.
 */
export function parseOidcEnvProviders(env: NodeJS.ProcessEnv): OidcEnvProvider[] {
  const buckets = new Map<string, OidcEnvBucket>();

  for (const [key, rawValue] of Object.entries(env)) {
    const match = key.match(OIDC_ENV_KEY_PATTERN);
    if (!match) continue;

    const slugKey = match[1];
    if (!slugKey) continue;

    const slug = slugKey.toLowerCase();
    const field = match[2] as OidcEnvField;
    const value = rawValue?.trim() ?? "";

    if (field !== "ENABLED" && value === "") continue;

    const bucket = buckets.get(slug) ?? {};
    switch (field) {
      case "CLIENT_ID":
        bucket.clientId = value;
        break;
      case "CLIENT_SECRET":
        bucket.clientSecret = value;
        break;
      case "ISSUER_URL":
        bucket.issuerUrl = value;
        break;
      case "NAME":
        bucket.name = value;
        break;
      case "SCOPES":
        bucket.scopes = value;
        break;
      case "ENABLED":
        bucket.enabled = value;
        break;
    }
    buckets.set(slug, bucket);
  }

  const candidates: OidcEnvProvider[] = [];

  for (const [slug, bucket] of buckets) {
    const hasClientId = Boolean(bucket.clientId);
    const hasClientSecret = Boolean(bucket.clientSecret);
    const hasIssuerUrl = Boolean(bucket.issuerUrl);
    const trioCount = Number(hasClientId) + Number(hasClientSecret) + Number(hasIssuerUrl);

    if (trioCount === 0) {
      continue;
    }

    if (trioCount !== 3) {
      const missing: string[] = [];
      if (!hasClientId) missing.push("CLIENT_ID");
      if (!hasClientSecret) missing.push("CLIENT_SECRET");
      if (!hasIssuerUrl) missing.push("ISSUER_URL");
      throw new Error(
        `Invalid OIDC provider "${slug}": missing required env var(s): ${missing
          .map((suffix) => `OIDC_${slug}_${suffix}`)
          .join(", ")}`,
      );
    }

    const clientId = bucket.clientId;
    const clientSecret = bucket.clientSecret;
    const issuerUrl = bucket.issuerUrl;
    if (clientId === undefined || clientSecret === undefined || issuerUrl === undefined) {
      throw new Error(`Invalid OIDC provider "${slug}": incomplete configuration`);
    }

    candidates.push({
      id: slug,
      name: bucket.name ?? titleCaseSlug(slug),
      issuerUrl,
      clientId,
      clientSecret,
      scopes: bucket.scopes ?? "openid email profile",
      enabled: parseEnabledFlag(bucket.enabled, true),
    });
  }

  const result = oidcEnvProvidersArraySchema.safeParse(
    [...candidates].sort((a, b) => a.id.localeCompare(b.id)),
  );
  if (!result.success) {
    throw new Error(`Invalid OIDC env providers: ${result.error.message}`);
  }

  return result.data;
}
