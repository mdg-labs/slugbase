import { z } from "zod";

const providerIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, "Provider id must be a URL-safe slug");

export const oidcDeploymentProviderSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().min(1).default("openid email profile"),
  enabled: z.boolean().default(true),
});

export type OidcDeploymentProvider = z.infer<typeof oidcDeploymentProviderSchema>;

const oidcDeploymentProvidersArraySchema = z
  .array(oidcDeploymentProviderSchema)
  .superRefine((providers, ctx) => {
    const ids = new Set<string>();
    for (const [index, provider] of providers.entries()) {
      if (ids.has(provider.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate provider id: ${provider.id}`,
          path: [index, "id"],
        });
      }
      ids.add(provider.id);
    }
  });

/**
 * Parses hosted operator OIDC provider config (spec §11.3).
 * Unset/blank → `undefined` (DB-sourced providers for self-host).
 * Valid JSON array (including `[]`) → deployment-config source.
 */
export function parseOidcDeploymentProviders(
  raw: string | undefined,
): OidcDeploymentProvider[] | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid OIDC_DEPLOYMENT_PROVIDERS: must be valid JSON array");
  }

  const result = oidcDeploymentProvidersArraySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid OIDC_DEPLOYMENT_PROVIDERS: ${result.error.message}`,
    );
  }

  return result.data;
}
