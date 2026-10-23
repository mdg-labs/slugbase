import { bearerApiToken, hashApiToken } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import type { ApiTokenPrincipal, BearerAuthenticator } from "../http/authenticate.ts";
import { networkPrefixOf } from "../http/trusted-proxy.ts";

export interface ApiTokenAuthenticatorOptions {
  readonly store: Pick<AuthStore, "lookupApiToken">;
}

/**
 * The bearer authenticator of stage 4 (doc 01 section 4, doc 04 section 4.2): an
 * `Authorization: Bearer slb_...` header becomes a principal bound to one
 * workspace and limited to one scope through one `sys_api_token_lookup` round
 * trip, so a revoked, expired or disabled-account token, and a token whose
 * membership ended, is refused on the very next request (doc 10 T4, T18). A header
 * that is not a well-formed token, and a token the database does not know, are
 * the same answer: no principal. A database that cannot answer is an error, never
 * an anonymous request.
 */
export function createApiTokenAuthenticator({ store }: ApiTokenAuthenticatorOptions): BearerAuthenticator {
  return {
    credential: "bearer",
    async authenticate(authorization, { clientIp }) {
      const token = bearerApiToken(authorization);
      if (token === undefined) {
        return undefined;
      }
      const found = await store.lookupApiToken(hashApiToken(token), networkPrefixOf(clientIp) ?? null);
      if (found === undefined) {
        return undefined;
      }
      const principal: ApiTokenPrincipal = { kind: "api-token", tokenId: found.tokenId, accountId: found.accountId, workspaceId: found.workspaceId, scope: found.scope };
      return principal;
    },
  };
}
