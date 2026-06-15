import type { MailSettings, UpdateMailSettingsBody } from "@slugbase/shared-types";

import {
  apiFetch,
  parseApiErrorMessage,
  serverFetchJson,
} from "../../../lib/client-api-fetch.js";
import { fetchMembersWithFallback } from "../members-fetch.js";
import type {
  AiSettingsData,
  MailSettingsData,
  OidcProviderSummary,
  WorkspaceSummary,
} from "./workspace.types.js";

interface ApiMember {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}

export class MailTestRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MailTestRequestError";
  }
}

function mapMailSettingsFromApi(settings: MailSettings): MailSettingsData {
  return {
    host: settings.host ?? "",
    port: settings.port ?? 587,
    secure: settings.secure,
    username: settings.user ?? "",
    hasPassword: settings.hasPassword,
    fromAddress: settings.from ?? "",
    fromName: "SlugBase",
  };
}

function mapMailSettingsToApi(
  body: Omit<MailSettingsData, "hasPassword"> & { password?: string },
): UpdateMailSettingsBody {
  return {
    host: body.host,
    port: body.port,
    secure: body.secure,
    user: body.username,
    from: body.fromAddress,
    ...(body.password !== undefined ? { password: body.password } : {}),
  };
}

export async function loadWorkspaceSettingsContext(
  request: Request,
  currentUserId: string,
): Promise<{
  workspace: WorkspaceSummary;
  currentUserRole: ApiMember["role"];
  membersForbidden: boolean;
} | null> {
  const workspace = await serverFetchJson<WorkspaceSummary & { planSeats?: number | null }>(
    request,
    "/workspaces/active",
  );
  const { members, forbidden } = await fetchMembersWithFallback(request);
  if (!workspace) return null;

  if (forbidden || !members) {
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
      },
      currentUserRole: "ADMIN",
      membersForbidden: true,
    };
  }

  const currentMember = members.find((member) => member.userId === currentUserId);
  if (!currentMember) return null;

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
    },
    currentUserRole: currentMember.role,
    membersForbidden: false,
  };
}

export async function loadMailSettings(request: Request): Promise<MailSettingsData | null> {
  const settings = await serverFetchJson<MailSettings>(request, "/workspace/settings/mail");
  return settings ? mapMailSettingsFromApi(settings) : null;
}

export async function loadAiSettings(request: Request): Promise<AiSettingsData | null> {
  return serverFetchJson<AiSettingsData>(request, "/workspace/settings/ai");
}

export async function loadOidcProviders(
  request: Request,
): Promise<OidcProviderSummary[] | null> {
  const data = await serverFetchJson<{ providers: OidcProviderSummary[] }>(
    request,
    "/workspace/settings/oidc/providers",
  );
  return data?.providers ?? null;
}

export async function updateWorkspaceName(name: string): Promise<WorkspaceSummary> {
  const res = await apiFetch("/workspaces/active", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as WorkspaceSummary;
}

export async function deleteWorkspace(): Promise<void> {
  const res = await apiFetch("/workspaces/active", { method: "DELETE", csrf: true });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function updateMailSettings(
  body: Omit<MailSettingsData, "hasPassword"> & { password?: string },
): Promise<MailSettingsData> {
  const res = await apiFetch("/workspace/settings/mail", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(mapMailSettingsToApi(body)),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return mapMailSettingsFromApi((await res.json()) as MailSettings);
}

export async function sendMailTest(recipientEmail: string): Promise<void> {
  const res = await apiFetch("/workspace/settings/mail/test", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ to: recipientEmail }),
  });
  if (!res.ok) {
    throw new MailTestRequestError(res.status, await parseApiErrorMessage(res));
  }
}

export async function updateAiSettings(body: {
  enabled: boolean;
  apiKey?: string;
  model?: string;
}): Promise<AiSettingsData> {
  const res = await apiFetch("/workspace/settings/ai", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
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
  const res = await apiFetch("/workspace/settings/oidc/providers", {
    method: "POST",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
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
  const res = await apiFetch(`/workspace/settings/oidc/providers/${providerId}`, {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as OidcProviderSummary;
}

export async function deleteOidcProvider(providerId: string): Promise<void> {
  const res = await apiFetch(`/workspace/settings/oidc/providers/${providerId}`, {
    method: "DELETE",
    csrf: true,
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}
