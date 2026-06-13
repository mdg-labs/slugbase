import {
  apiFetch,
  parseApiErrorMessage,
  serverFetchJson,
} from "../../../lib/client-api-fetch.js";
import type {
  BillingPlanId,
  BillingSettingsData,
  BillingWorkspaceSummary,
  StartCheckoutParams,
} from "./billing.types.js";
import { loadBillingPlanDisplayConfig } from "./billing-config.js";
import { fetchMembersWithFallback } from "../members-fetch.js";

interface PaginatedBookmarks {
  total: number;
}

interface ApiWorkspace extends BillingWorkspaceSummary {
  slug: string;
  createdAt: string;
  updatedAt: string;
}

function estimateArchivedCount(plan: BillingPlanId, bookmarkCount: number, cap: number): number {
  if (plan !== "free") return 0;
  return Math.max(0, bookmarkCount - cap);
}

export async function loadBillingSettingsData(
  request: Request,
  currentUserId: string,
  returnUrl: string,
): Promise<BillingSettingsData | null> {
  const planConfig = await loadBillingPlanDisplayConfig();
  const workspace = await serverFetchJson<ApiWorkspace>(request, "/workspaces/active");
  const { members, forbidden } = await fetchMembersWithFallback(request);
  const bookmarkTotals = await serverFetchJson<PaginatedBookmarks>(
    request,
    "/bookmarks?pageSize=1",
  );

  if (!workspace || !bookmarkTotals) {
    return null;
  }

  const bookmarkCount = bookmarkTotals.total;
  const cap = planConfig.freeBookmarkCap;

  if (forbidden || !members) {
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
        planSeats: workspace.planSeats,
        planArchived: workspace.planArchived,
        billingCustomerId: workspace.billingCustomerId,
        billingSubscriptionId: workspace.billingSubscriptionId,
        billingStatus: workspace.billingStatus,
        billingPeriodEnd: workspace.billingPeriodEnd,
        permanentPersonal: workspace.permanentPersonal,
        billingInterval: workspace.billingInterval,
      },
      bookmarkCount,
      archivedBookmarkCount: estimateArchivedCount(workspace.plan, bookmarkCount, cap),
      memberCount: 0,
      currentUserId,
      currentUserRole: "ADMIN",
      membersForbidden: true,
      planConfig,
      returnUrl,
    };
  }

  const currentMember = members.find((member) => member.userId === currentUserId);

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
      planSeats: workspace.planSeats,
      planArchived: workspace.planArchived,
      billingCustomerId: workspace.billingCustomerId,
      billingSubscriptionId: workspace.billingSubscriptionId,
      billingStatus: workspace.billingStatus,
      billingPeriodEnd: workspace.billingPeriodEnd,
      permanentPersonal: workspace.permanentPersonal,
      billingInterval: workspace.billingInterval,
    },
    bookmarkCount,
    archivedBookmarkCount: estimateArchivedCount(workspace.plan, bookmarkCount, cap),
    memberCount: members.length,
    currentUserId,
    currentUserRole: currentMember?.role ?? "ADMIN",
    membersForbidden: false,
    planConfig,
    returnUrl,
  };
}

export async function startCheckout(params: StartCheckoutParams): Promise<{ checkoutUrl: string }> {
  const res = await apiFetch(`/workspaces/${params.workspaceId}/billing/checkout`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({
      plan: params.plan,
      mode: params.mode,
      billingInterval: params.billingInterval ?? "monthly",
      ...(params.plan === "team" && params.seatQuantity !== undefined
        ? { seatQuantity: params.seatQuantity }
        : {}),
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const body = (await res.json()) as { checkoutUrl: string };
  return { checkoutUrl: body.checkoutUrl };
}

export async function openBillingPortal(
  workspaceId: string,
  returnUrl: string,
): Promise<{ portalUrl: string }> {
  const res = await apiFetch(`/workspaces/${workspaceId}/billing/portal`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ returnUrl }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const body = (await res.json()) as { portalUrl: string };
  return { portalUrl: body.portalUrl };
}

export async function updateSeatQuantity(
  workspaceId: string,
  totalSeats: number,
): Promise<BillingWorkspaceSummary> {
  const res = await apiFetch(`/workspaces/${workspaceId}/billing/seats`, {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify({ totalSeats }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const body = (await res.json()) as ApiWorkspace;
  return {
    id: body.id,
    name: body.name,
    plan: body.plan,
    planSeats: body.planSeats,
    planArchived: body.planArchived,
    billingCustomerId: body.billingCustomerId,
    billingSubscriptionId: body.billingSubscriptionId,
    billingStatus: body.billingStatus,
    billingPeriodEnd: body.billingPeriodEnd,
    permanentPersonal: body.permanentPersonal,
    billingInterval: body.billingInterval,
  };
}
