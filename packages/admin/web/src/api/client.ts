import type {
  AccountDetail,
  AdminInvite,
  AdminUser,
  ApiError,
  BillingSummary,
  LiveOverviewStats,
  PaginatedAccounts,
  PaginatedMetricsHistory,
  PaginatedWorkspaces,
  WorkspaceDetail,
} from "./types.js";

export class AdminApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? (body as ApiError).error
        : `Request failed (${String(response.status)})`;
    throw new AdminApiError(message, response.status);
  }
  return body as T;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  return parseJson<T>(response);
}

export async function login(email: string, password: string): Promise<AdminUser> {
  const result = await apiFetch<{ user: AdminUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return result.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}

export async function getMe(): Promise<AdminUser> {
  return apiFetch<AdminUser>("/api/auth/me");
}

export async function acceptInvite(
  token: string,
  password: string,
): Promise<AdminUser> {
  const result = await apiFetch<{ user: AdminUser }>("/api/auth/invites/accept", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
  return result.user;
}

export async function getOverview(): Promise<LiveOverviewStats> {
  return apiFetch<LiveOverviewStats>("/api/overview");
}

export async function listAccounts(params: {
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
}): Promise<PaginatedAccounts> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.sort !== undefined) search.set("sort", params.sort);
  if (params.order !== undefined) search.set("order", params.order);
  const query = search.toString();
  return apiFetch<PaginatedAccounts>(`/api/accounts${query ? `?${query}` : ""}`);
}

export async function getAccount(id: string): Promise<AccountDetail> {
  const result = await apiFetch<{ account: AccountDetail }>(`/api/accounts/${id}`);
  return result.account;
}

export async function listWorkspaces(params: {
  page?: number;
  limit?: number;
}): Promise<PaginatedWorkspaces> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const query = search.toString();
  return apiFetch<PaginatedWorkspaces>(
    `/api/workspaces${query ? `?${query}` : ""}`,
  );
}

export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  const result = await apiFetch<{ workspace: WorkspaceDetail }>(
    `/api/workspaces/${id}`,
  );
  return result.workspace;
}

export async function getBillingSummary(): Promise<BillingSummary> {
  return apiFetch<BillingSummary>("/api/billing/summary");
}

export async function getMetricsHistory(params: {
  page?: number;
  limit?: number;
}): Promise<PaginatedMetricsHistory> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const query = search.toString();
  return apiFetch<PaginatedMetricsHistory>(
    `/api/metrics/history${query ? `?${query}` : ""}`,
  );
}

export async function listInvites(): Promise<AdminInvite[]> {
  const result = await apiFetch<{ invites: AdminInvite[] }>("/api/auth/invites");
  return result.invites;
}

export async function createInvite(
  email: string,
  role: string,
): Promise<AdminInvite> {
  const result = await apiFetch<{ invite: AdminInvite }>("/api/auth/invites", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
  return result.invite;
}

export async function revokeInvite(id: string): Promise<void> {
  const response = await fetch(`/api/auth/invites/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    await parseJson(response);
  }
}
