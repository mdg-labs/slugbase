import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient, type ApiProblemCode } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";

export type InstanceWorkspace = ComponentTypes["schemas"]["InstanceWorkspace"];
export type InstanceWorkspaceCreated = ComponentTypes["schemas"]["InstanceWorkspaceCreated"];
export type InstanceOwnerInvitation = ComponentTypes["schemas"]["InstanceOwnerInvitation"];

export const ADMIN_WORKSPACES_QUERY_KEY = ["admin", "workspaces"] as const;

/** Every workspace that is not being deleted, newest first. Only an instance admin with a second factor may ask. */
export function instanceWorkspacesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ADMIN_WORKSPACES_QUERY_KEY,
    queryFn: async ({ signal }): Promise<readonly InstanceWorkspace[]> => {
      const { data, error } = await api.GET("/api/v1/instance/workspaces", { signal });
      if (data === undefined) {
        throw new Error("The instance workspaces request did not answer with a document", { cause: error });
      }
      return data.items;
    },
  });
}

/** Whether the call failed because the shared re-authentication prompt was closed, or the server still wants one. */
function asksForReauth(caught: unknown): boolean {
  return isReauthCancelled(caught) || (caught instanceof ApiProblemError && caught.status === 401 && caught.code === "reauth_required");
}

function hasFieldError(error: ApiProblemError, path: string, code?: string): boolean {
  return error.errors.some((field) => field.path === path && (code === undefined || field.code === code));
}

/** The first owner of a new workspace: an existing account, or the address an owner invitation is for. */
export type OwnerChoice = { readonly kind: "account"; readonly accountId: string } | { readonly kind: "invitation"; readonly email: string };

/** Why a creation was refused, as far as the admin is told. */
export type CreationRefusal =
  | { readonly kind: "invalidName" | "invalidEmail" | "unknownAccount" | "invalid" | "forbidden" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

export type WorkspaceCreation =
  | { readonly status: "created"; readonly workspace: InstanceWorkspaceCreated }
  | { readonly status: "refused"; readonly refusal: CreationRefusal };

/**
 * Creates a workspace for an owner (doc 04 section 10.10). With an account that account is the owner; with an address the
 * workspace waits for its first owner, and the answer carries the invitation, with its link only where no email can be sent.
 * A refusal the dialog explains is an answer; any other failure throws.
 */
export async function createInstanceWorkspace(api: ApiClient, name: string, owner: OwnerChoice, signal: AbortSignal): Promise<WorkspaceCreation> {
  try {
    const { data, error } = await api.POST("/api/v1/instance/workspaces", {
      body: owner.kind === "account" ? { name, ownerAccountId: owner.accountId } : { name, ownerEmail: owner.email },
      signal,
    });
    if (data === undefined) {
      throw new Error("The workspace creation did not answer with a document", { cause: error });
    }
    return { status: "created", workspace: data };
  } catch (caught) {
    if (caught instanceof ApiProblemError) {
      if (caught.status === 429) {
        return { status: "refused", refusal: { kind: "rateLimited", seconds: caught.retryAfterSeconds } };
      }
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 422) {
        if (hasFieldError(caught, "ownerAccountId", "unknown_account")) {
          return { status: "refused", refusal: { kind: "unknownAccount" } };
        }
        if (hasFieldError(caught, "name")) {
          return { status: "refused", refusal: { kind: "invalidName" } };
        }
        if (hasFieldError(caught, "ownerEmail")) {
          return { status: "refused", refusal: { kind: "invalidEmail" } };
        }
        return { status: "refused", refusal: { kind: "invalid" } };
      }
    }
    throw caught;
  }
}

/** Why the admin was not added to a workspace, as far as they are told. */
export type MembershipRefusal = { readonly kind: "reauthRequired" | "forbidden" | "gone" | "alreadyMember" };

export type MembershipAdded = { readonly status: "added" } | { readonly status: "refused"; readonly refusal: MembershipRefusal };

/**
 * Adds the calling admin to the workspace as a member (doc 04 section 10.10); its owners see it in the workspace's audit log. The call
 * needs a fresh re-authentication, which the API client asks for with the shared prompt. A refusal is an answer; any other failure throws.
 */
export async function addMeAsMember(api: ApiClient, workspaceId: string): Promise<MembershipAdded> {
  try {
    const { data, error } = await api.POST("/api/v1/instance/workspaces/{id}/membership", { params: { path: { id: workspaceId } } });
    if (data === undefined) {
      throw new Error("The membership request did not answer with a document", { cause: error });
    }
    return { status: "added" };
  } catch (caught) {
    if (asksForReauth(caught)) {
      return { status: "refused", refusal: { kind: "reauthRequired" } };
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 404) {
        return { status: "refused", refusal: { kind: "gone" } };
      }
      if (caught.status === 409 && caught.code === "already_member") {
        return { status: "refused", refusal: { kind: "alreadyMember" } };
      }
    }
    throw caught;
  }
}

/** Why a deletion was refused, as far as the admin is told. A guard refusal carries the code the deployment's deletion guard answered with. */
export type DeletionRefusal = { readonly kind: "reauthRequired" | "forbidden" | "gone" } | { readonly kind: "guard"; readonly code: ApiProblemCode };

export type WorkspaceDeletion = { readonly status: "accepted" } | { readonly status: "refused"; readonly refusal: DeletionRefusal };

/**
 * Deletes the workspace (doc 04 section 10.10): hidden at once, its rows removed by a background job. The call needs a fresh
 * re-authentication, which the API client asks for with the shared prompt. A refusal the dialog explains is an answer; any other
 * failure throws.
 */
export async function deleteInstanceWorkspace(api: ApiClient, workspaceId: string): Promise<WorkspaceDeletion> {
  try {
    const { response, error } = await api.DELETE("/api/v1/instance/workspaces/{id}", { params: { path: { id: workspaceId } } });
    if (!response.ok) {
      throw new Error("The workspace deletion did not answer with a success", { cause: error });
    }
    return { status: "accepted" };
  } catch (caught) {
    if (asksForReauth(caught)) {
      return { status: "refused", refusal: { kind: "reauthRequired" } };
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 404) {
        return { status: "refused", refusal: { kind: "gone" } };
      }
      if (caught.status === 409) {
        return { status: "refused", refusal: { kind: "guard", code: caught.code } };
      }
    }
    throw caught;
  }
}

/** Why an owner invitation was refused, as far as the admin is told. */
export type InvitationRefusal =
  | { readonly kind: "reauthRequired" | "forbidden" | "gone" | "hasOwner" | "emailRequired" | "invalidEmail" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

export type OwnerInvitationIssued =
  | { readonly status: "issued"; readonly invitation: InstanceOwnerInvitation }
  | { readonly status: "refused"; readonly refusal: InvitationRefusal };

/**
 * Issues a new owner invitation for a workspace that waits for its first owner, which revokes the earlier ones. Without an address
 * the one of the latest invitation is used. The call needs a fresh re-authentication, which the API client asks for with the
 * shared prompt. A refusal the dialog explains is an answer; any other failure throws.
 */
export async function issueOwnerInvitation(api: ApiClient, workspaceId: string, ownerEmail: string | undefined, signal: AbortSignal): Promise<OwnerInvitationIssued> {
  try {
    const { data, error } = await api.POST("/api/v1/instance/workspaces/{id}/owner-invitation", {
      params: { path: { id: workspaceId } },
      body: ownerEmail === undefined ? {} : { ownerEmail },
      signal,
    });
    if (data === undefined) {
      throw new Error("The owner invitation did not answer with a document", { cause: error });
    }
    return { status: "issued", invitation: data };
  } catch (caught) {
    if (asksForReauth(caught)) {
      return { status: "refused", refusal: { kind: "reauthRequired" } };
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 429) {
        return { status: "refused", refusal: { kind: "rateLimited", seconds: caught.retryAfterSeconds } };
      }
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 404) {
        return { status: "refused", refusal: { kind: "gone" } };
      }
      if (caught.status === 409 && caught.code === "workspace_has_owner") {
        return { status: "refused", refusal: { kind: "hasOwner" } };
      }
      if (caught.status === 422) {
        return { status: "refused", refusal: { kind: hasFieldError(caught, "ownerEmail", "owner_email_required") ? "emailRequired" : "invalidEmail" } };
      }
    }
    throw caught;
  }
}
