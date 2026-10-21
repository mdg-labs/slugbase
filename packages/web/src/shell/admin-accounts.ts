import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, ApiWorkspacesProblemError, type ApiClient, type ApiProblemCode, type ProblemWorkspace } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";

export type InstanceAccount = ComponentTypes["schemas"]["InstanceAccount"];

export const ADMIN_ACCOUNTS_QUERY_KEY = ["admin", "accounts"] as const;

/** Every account of the instance, oldest first. Only an instance admin with a second factor may ask. */
export function instanceAccountsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ADMIN_ACCOUNTS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<readonly InstanceAccount[]> => {
      const { data, error } = await api.GET("/api/v1/instance/accounts", { signal });
      if (data === undefined) {
        throw new Error("The instance accounts request did not answer with a document", { cause: error });
      }
      return data.items;
    },
  });
}

type SimpleRefusal =
  | "reauthRequired"
  | "forbidden"
  | "gone"
  | "lastInstanceAdmin"
  | "accountDisabled"
  | "emailUnverified"
  | "noPassword"
  | "alreadyVerified"
  | "mailUnavailable"
  | "self"
  | "invalid";

/** Why an action on an account was refused, as far as the admin is told. A guard refusal carries the code the deployment's deletion guard answered with. */
export type AccountRefusal =
  | { readonly kind: SimpleRefusal }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "lastOwner"; readonly workspaces: readonly ProblemWorkspace[] }
  | { readonly kind: "guard"; readonly code: ApiProblemCode };

export type AccountOutcome<Done extends object = object> = ({ readonly status: "done" } & Done) | { readonly status: "refused"; readonly refusal: AccountRefusal };

const FIELD_CODES: Readonly<Record<string, SimpleRefusal>> = {
  last_instance_admin: "lastInstanceAdmin",
  account_disabled: "accountDisabled",
  email_unverified: "emailUnverified",
  no_password: "noPassword",
  already_verified: "alreadyVerified",
  self: "self",
};

/** The refusal an error stands for, or undefined when the error is no answer the page explains. */
function refusalOf(caught: unknown): AccountRefusal | undefined {
  if (isReauthCancelled(caught)) {
    return { kind: "reauthRequired" };
  }
  if (!(caught instanceof ApiProblemError)) {
    return undefined;
  }
  switch (caught.status) {
    case 401:
      return caught.code === "reauth_required" ? { kind: "reauthRequired" } : undefined;
    case 403:
      return { kind: "forbidden" };
    case 404:
      return { kind: "gone" };
    case 409:
      return caught.code === "last_owner"
        ? { kind: "lastOwner", workspaces: caught instanceof ApiWorkspacesProblemError ? caught.workspaces : [] }
        : { kind: "guard", code: caught.code };
    case 422: {
      for (const field of caught.errors) {
        const kind = FIELD_CODES[field.code];
        if (kind !== undefined) {
          return { kind };
        }
      }
      return { kind: "invalid" };
    }
    case 429:
      return { kind: "rateLimited", seconds: caught.retryAfterSeconds };
    case 503:
      return caught.code === "mail_unavailable" ? { kind: "mailUnavailable" } : undefined;
    default:
      return undefined;
  }
}

async function attempt<Done extends object>(call: () => Promise<Done>): Promise<AccountOutcome<Done>> {
  try {
    return { status: "done", ...(await call()) };
  } catch (caught) {
    const refusal = refusalOf(caught);
    if (refusal === undefined) {
      throw caught;
    }
    return { status: "refused", refusal };
  }
}

/** The changes `PATCH /instance/accounts/{id}` takes: the instance-admin flag, the disabled flag, and marking the address verified. */
export type AccountChange = { readonly isInstanceAdmin: boolean } | { readonly disabled: boolean } | { readonly emailVerified: true };

/**
 * Changes an account (doc 04 section 10.10). The call needs a fresh re-authentication, which the API client asks for with the shared prompt.
 * A refusal the page explains is an answer; any other failure throws.
 */
export function updateInstanceAccount(api: ApiClient, id: string, change: AccountChange): Promise<AccountOutcome> {
  return attempt(async () => {
    const { data, error } = await api.PATCH("/api/v1/instance/accounts/{id}", { params: { path: { id } }, body: change });
    if (data === undefined) {
      throw new Error("The account update did not answer with a document", { cause: error });
    }
    return {};
  });
}

/** Turns the second factor of an account off, and ends its sessions. The call needs a fresh re-authentication. */
export function resetInstanceAccountMfa(api: ApiClient, id: string): Promise<AccountOutcome> {
  return attempt(async () => {
    const { response, error } = await api.POST("/api/v1/instance/accounts/{id}/mfa-reset", { params: { path: { id } } });
    if (!response.ok) {
      throw new Error("The second factor reset did not answer with a success", { cause: error });
    }
    return {};
  });
}

/** Where a password-reset link went: mailed to the account, or returned here once because no mail adapter is configured. */
export type ResetLinkDelivery = { readonly delivery: "mail" } | { readonly delivery: "link"; readonly link: string };

/** Issues a one-hour password-reset link for the account. The call needs a fresh re-authentication. */
export function issueInstanceAccountResetLink(api: ApiClient, id: string): Promise<AccountOutcome<ResetLinkDelivery>> {
  return attempt(async (): Promise<ResetLinkDelivery> => {
    const { data, error } = await api.POST("/api/v1/instance/accounts/{id}/password-reset-link", { params: { path: { id } } });
    if (data === undefined) {
      throw new Error("The reset link request did not answer with a document", { cause: error });
    }
    if (data.delivery === "mail") {
      return { delivery: "mail" };
    }
    if (data.link === null) {
      throw new Error("The reset link request answered with a link delivery and no link");
    }
    return { delivery: "link", link: data.link };
  });
}

/** Queues a new verification email for the account. */
export function resendInstanceAccountVerification(api: ApiClient, id: string): Promise<AccountOutcome> {
  return attempt(async () => {
    const { response, error } = await api.POST("/api/v1/instance/accounts/{id}/verification-email", { params: { path: { id } } });
    if (!response.ok) {
      throw new Error("The verification email request did not answer with a success", { cause: error });
    }
    return {};
  });
}

/** Deletes another account, after its ownership is resolved. The call needs a fresh re-authentication. */
export function deleteInstanceAccount(api: ApiClient, id: string): Promise<AccountOutcome> {
  return attempt(async () => {
    const { response, error } = await api.DELETE("/api/v1/instance/accounts/{id}", { params: { path: { id } } });
    if (!response.ok) {
      throw new Error("The account deletion did not answer with a success", { cause: error });
    }
    return {};
  });
}
