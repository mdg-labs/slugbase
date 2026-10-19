import { ApiProblemError, ApiWorkspacesProblemError, type ApiClient, type ApiProblemCode, type ProblemWorkspace } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";

/** Why the deletion of the account was refused, as far as the member is told. */
export type AccountDeletionRefusal =
  | { readonly kind: "reauthRequired" }
  /** The address typed is not the account's own, as the server has it. */
  | { readonly kind: "emailMismatch" }
  /** The account is the only owner of workspaces that have other members. */
  | { readonly kind: "lastOwner"; readonly workspaces: readonly ProblemWorkspace[] }
  /** The account is the only instance admin. */
  | { readonly kind: "lastInstanceAdmin" }
  /** A deployment extension refuses the deletion; the code is the one it answered with. */
  | { readonly kind: "guard"; readonly code: ApiProblemCode };

export type AccountDeletion = { readonly status: "accepted" } | { readonly status: "refused"; readonly refusal: AccountDeletionRefusal };

function hasFieldCode(error: ApiProblemError, code: string): boolean {
  return error.errors.some((field) => field.path === "email" && field.code === code);
}

/**
 * Asks for the signed-in account to be deleted (doc 02 section 2.10, doc 04 section 4.4). The call needs a fresh re-authentication;
 * the API client opens the shared prompt for it and sends the call again. A refusal the dialog explains (the prompt was closed, the
 * address does not match, the account is the last owner of a workspace or the last instance admin, a deployment extension refuses)
 * is an answer; any other failure throws.
 */
export async function deleteAccount(api: ApiClient, email: string): Promise<AccountDeletion> {
  try {
    const { response, error } = await api.DELETE("/api/v1/me", { body: { email } });
    if (!response.ok) {
      throw new Error("The account deletion did not answer with a problem document", { cause: error });
    }
    return { status: "accepted" };
  } catch (caught) {
    if (isReauthCancelled(caught)) {
      return { status: "refused", refusal: { kind: "reauthRequired" } };
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 401 && caught.code === "reauth_required") {
        return { status: "refused", refusal: { kind: "reauthRequired" } };
      }
      if (caught.status === 409) {
        return {
          status: "refused",
          refusal: caught.code === "last_owner" ? { kind: "lastOwner", workspaces: caught instanceof ApiWorkspacesProblemError ? caught.workspaces : [] } : { kind: "guard", code: caught.code },
        };
      }
      if (caught.status === 422 && caught.code === "validation_failed") {
        if (hasFieldCode(caught, "last_instance_admin")) {
          return { status: "refused", refusal: { kind: "lastInstanceAdmin" } };
        }
        if (hasFieldCode(caught, "email_mismatch")) {
          return { status: "refused", refusal: { kind: "emailMismatch" } };
        }
      }
    }
    throw caught;
  }
}
