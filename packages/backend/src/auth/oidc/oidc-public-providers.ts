import type { PublicOidcProviderItem } from "@slugbase/shared-types";

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
