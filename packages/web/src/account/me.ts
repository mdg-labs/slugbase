import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export type Me = ComponentTypes["schemas"]["Me"];
export type Account = ComponentTypes["schemas"]["Account"];
export type UpdateAccountRequest = ComponentTypes["schemas"]["UpdateAccountRequest"];

export const ME_QUERY_KEY = ["me"] as const;

/** The signed-in account with its memberships. Every answer of it belongs to the session, so sign-out clears it with the rest of the cache. */
export function meQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ME_QUERY_KEY,
    queryFn: async (): Promise<Me> => {
      const { data, error } = await api.GET("/api/v1/me");
      if (data === undefined) {
        throw new Error("The account request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/** `me` with its account replaced by the answer of an update, so everything that reads the account sees the change without another request. */
export function withAccount(me: Me | undefined, account: Account): Me | undefined {
  return me === undefined ? undefined : { ...me, account };
}

/** The preferences `PATCH /me` changes besides the profile. */
export type PreferenceChanges = Pick<
  UpdateAccountRequest,
  "theme" | "accent" | "defaultView" | "singleKeyShortcuts" | "aiOptOut" | "analyticsConsent" | "onboarding"
>;
