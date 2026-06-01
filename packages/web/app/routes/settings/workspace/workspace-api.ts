import type {
  AiSettingsData,
  MailSettingsData,
  OidcProviderSummary,
  WorkspaceSummary,
} from "./workspace.types.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string };
    return data.message ?? "Request failed";
  } catch {
    return "Request failed";
  }
}

async function getMutationHeaders(request?: Request): Promise<Record<string, string>> {
  const cookie = request?.headers.get("Cookie") ?? "";
  const res = await fetch(`${getApiBaseUrl()}/auth/csrf-token`, {
    headers: cookie ? { Cookie: cookie } : {},
    credentials: request ? undefined : "include",
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

interface ApiMember {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}

export async function loadWorkspaceSettingsContext(
  request: Request,
  currentUserId: string,
): Promise<{
  workspace: WorkspaceSummary;
  currentUserRole: ApiMember["role"];
} | null> {
  const workspace = await fetchJson<WorkspaceSummary & { planSeats?: number | null }>(
    "/workspaces/active",
    request,
  );
  const members = await fetchJson<ApiMember[]>("/members", request);
  if (!workspace || !members) return null;

  const currentMember = members.find((member) => member.userId === currentUserId);
  if (!currentMember) return null;

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
    },
    currentUserRole: currentMember.role,
  };
}

export async function loadMailSettings(request?: Request): Promise<MailSettingsData | null> {
  return fetchJson<MailSettingsData>("/workspace/settings/mail", request);
}

export async function loadAiSettings(request?: Request): Promise<AiSettingsData | null> {
  return fetchJson<AiSettingsData>("/workspace/settings/ai", request);
}

export async function loadOidcProviders(
  request?: Request,
): Promise<OidcProviderSummary[] | null> {
  const data = await fetchJson<{ providers: OidcProviderSummary[] }>(
    "/workspace/settings/oidc/providers",
    request,
  );
  return data?.providers ?? null;
}

export async function updateWorkspaceName(name: string): Promise<WorkspaceSummary> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const body = (await res.json()) as WorkspaceSummary;
  return body;
}

export async function deleteWorkspace(): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function updateMailSettings(
  body: Omit<MailSettingsData, "hasPassword"> & { password?: string },
): Promise<MailSettingsData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace/settings/mail`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as MailSettingsData;
}

export async function sendMailTest(recipientEmail: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace/settings/mail/test`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ to: recipientEmail }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function updateAiSettings(body: {
  enabled: boolean;
  apiKey?: string;
  model?: string;
}): Promise<AiSettingsData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace/settings/ai`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as AiSettingsData;
}

export async function createOidcProvider(body: {
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
}): Promise<OidcProviderSummary> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace/settings/oidc/providers`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as OidcProviderSummary;
}

export async function updateOidcProvider(
  providerId: string,
  body: Partial<{
    name: string;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    enabled: boolean;
  }>,
): Promise<OidcProviderSummary> {
  const headers = await getMutationHeaders();
  const res = await fetch(
    `${getApiBaseUrl()}/workspace/settings/oidc/providers/${providerId}`,
    {
      method: "PATCH",
      headers,
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as OidcProviderSummary;
}

export async function deleteOidcProvider(providerId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(
    `${getApiBaseUrl()}/workspace/settings/oidc/providers/${providerId}`,
    {
      method: "DELETE",
      headers,
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}
