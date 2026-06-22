import type { PublicOidcProviderItem } from "@slugbase/shared-types";

import type { OidcEnvProvider } from "../../config/oidc-env-providers.js";

/** Maps env-configured providers to the safe public login/register provider shape. */
export function toPublicOidcLoginProviders(
  providers: OidcEnvProvider[],
): PublicOidcProviderItem[] {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
    }));
}
