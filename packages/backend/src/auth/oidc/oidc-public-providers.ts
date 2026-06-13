import type { PublicOidcProviderItem } from "@slugbase/shared-types";

import type { OidcDeploymentProvider } from "../../config/env.schema.js";
import type { OidcProviderRecord } from "./oidc.types.js";

/** Maps DB records to the safe public login/register provider shape. */
export function toPublicOidcLoginProviders(
  providers: OidcProviderRecord[],
): PublicOidcProviderItem[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
  }));
}

/** Maps deployment-config providers to the safe public login/register shape. */
export function toPublicOidcLoginProvidersFromDeployment(
  providers: OidcDeploymentProvider[],
): PublicOidcProviderItem[] {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
    }));
}
