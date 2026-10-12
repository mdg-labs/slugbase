import type { Port } from "./port.ts";

export type WorkspaceRole = "owner" | "admin" | "member";

/** The authenticated principal of a request. */
export type TenantPrincipal =
  | { readonly kind: "session"; readonly accountId: string; readonly activeWorkspaceId: string | undefined }
  | { readonly kind: "api-token"; readonly accountId: string; readonly workspaceId: string };

export interface TenantResolution {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly role: WorkspaceRole;
}

/**
 * Turns an authenticated request into its workspace, member and role
 * (doc 01 section 5.2); undefined when the principal has no workspace to act in.
 */
export interface TenantResolver extends Port {
  resolve(principal: TenantPrincipal): Promise<TenantResolution | undefined>;
}
