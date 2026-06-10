import type {
  BillingPlanId,
  BillingSettingsData,
  BillingWorkspaceSummary,
  StartCheckoutParams,
} from "./billing.types.js";
import { loadBillingPlanDisplayConfig } from "./billing-config.js";
import { fetchMembersWithFallback } from "../members-fetch.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

interface PaginatedBookmarks {
  total: number;
}

interface ApiWorkspace extends BillingWorkspaceSummary {
  slug: string;
  createdAt: string;
  updatedAt: string;
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string };
    return data.message ?? "Request failed";
  } catch {
    return "Request failed";
  }
}

async function getMutationHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${getApiBaseUrl()}/auth/csrf-token`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch CSRF token");
  }
  const data = (await res.json()) as { csrfToken: string };
  return {
    "Content-Type": "application/json",
    "x-csrf-token": data.csrfToken,
  };
}

async function fetchJson<T>(path: string, request?: Request): Promise<T | null> {
  const cookie = request?.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getApiBaseUrl()}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
      credentials: request ? undefined : "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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
  const workspace = await fetchJson<ApiWorkspace>("/workspaces/active", request);
  const { members, forbidden } = await fetchMembersWithFallback(request);
  const bookmarkTotals = await fetchJson<PaginatedBookmarks>(
    "/bookmarks?pageSize=1",
    request,
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
  const headers = await getMutationHeaders();
  const res = await fetch(
    `${getApiBaseUrl()}/workspaces/${params.workspaceId}/billing/checkout`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({
        plan: params.plan,
        mode: params.mode,
        billingInterval: params.billingInterval ?? "monthly",
        successUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const body = (await res.json()) as { checkoutUrl: string };
  return { checkoutUrl: body.checkoutUrl };
}

export async function openBillingPortal(
  workspaceId: string,
  returnUrl: string,
): Promise<{ portalUrl: string }> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspaces/${workspaceId}/billing/portal`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ returnUrl }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const body = (await res.json()) as { portalUrl: string };
  return { portalUrl: body.portalUrl };
}

export async function updateSeatQuantity(
  workspaceId: string,
  totalSeats: number,
): Promise<BillingWorkspaceSummary> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspaces/${workspaceId}/billing/seats`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify({ totalSeats }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
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
  };
}
