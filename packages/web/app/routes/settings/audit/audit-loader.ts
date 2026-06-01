import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { getSessionUser } from "../../../lib/session-client.js";
import { loadAuditEvents, loadAuditWorkspacePlan } from "./audit-api.js";
import { canAccessAuditLog } from "./audit-entitlements.js";
import type { AuditLoaderData } from "./audit.types.js";
import { AUDIT_PAGE_SIZE } from "./audit.types.js";

export async function auditSettingsLoader({
  request,
}: LoaderFunctionArgs): Promise<AuditLoaderData> {
  const user = await getSessionUser(request);
  if (!user) {
    return redirect("/login") as never;
  }

  const workspace = await loadAuditWorkspacePlan(request);
  if (!workspace) {
    throw new Error("Failed to load workspace");
  }

  if (!canAccessAuditLog(workspace)) {
    return { canAccess: false, workspace, events: null };
  }

  const url = new URL(request.url);
  const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
  const search = url.searchParams.get("search") ?? undefined;
  const actorId = url.searchParams.get("actor") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;

  const events = await loadAuditEvents(request, {
    page,
    pageSize: AUDIT_PAGE_SIZE,
    search,
    actorId,
    type,
  });

  return { canAccess: true, workspace, events };
}
