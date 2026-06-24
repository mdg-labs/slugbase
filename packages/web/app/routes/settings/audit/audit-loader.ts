import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { getSessionUser } from "../../../lib/session-client.js";
import { loadAuditEvents, loadAuditSettingsContext } from "./audit-api.js";
import { canAccessAuditLog } from "./audit-entitlements.js";
import type { AuditLoaderData } from "./audit.types.js";
import { AUDIT_PAGE_SIZE } from "./audit.types.js";
import { canManageWorkspaceSettings } from "../workspace/workspace-entitlements.js";

export async function auditSettingsLoader({
  request,
}: LoaderFunctionArgs): Promise<AuditLoaderData> {
  const user = await getSessionUser(request);
  if (!user) {
    return redirect("/login") as never;
  }

  const { workspace, currentUserRole } = await loadAuditSettingsContext(request);

  if (!workspace) {
    return {
      currentUserRole,
      workspace: null,
      events: null,
      roleDenied: false,
      planDenied: false,
      loadError: true,
    };
  }

  if (!canManageWorkspaceSettings(currentUserRole)) {
    return {
      currentUserRole,
      workspace,
      events: null,
      roleDenied: true,
      planDenied: false,
      loadError: false,
    };
  }

  if (!canAccessAuditLog(workspace)) {
    return {
      currentUserRole,
      workspace,
      events: null,
      roleDenied: false,
      planDenied: true,
      loadError: false,
    };
  }

  const url = new URL(request.url);
  const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
  const search = url.searchParams.get("search") ?? undefined;
  const actorId = url.searchParams.get("actor") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;

  const eventsResult = await loadAuditEvents(request, {
    page,
    pageSize: AUDIT_PAGE_SIZE,
    search,
    actorId,
    type,
  });

  if (!eventsResult.ok) {
    return {
      currentUserRole,
      workspace,
      events: null,
      roleDenied: false,
      planDenied: false,
      loadError: true,
    };
  }

  return {
    currentUserRole,
    workspace,
    events: eventsResult.data,
    roleDenied: false,
    planDenied: false,
    loadError: false,
  };
}
