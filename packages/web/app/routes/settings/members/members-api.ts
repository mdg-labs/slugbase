import type {
  InvitationRole,
  MemberRow,
  MemberRole,
  PendingInvitationRow,
  TeamRow,
  WorkspaceSummary,
} from "./members.types.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

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

interface ApiWorkspace {
  id: string;
  name: string;
  plan: WorkspaceSummary["plan"];
  planSeats: number | null;
}

interface PaginatedTeams {
  items: TeamRow[];
  total: number;
}

export async function loadMembersSettingsData(
  request: Request,
  currentUserId: string,
): Promise<{
  workspace: WorkspaceSummary;
  members: MemberRow[];
  pendingInvitations: PendingInvitationRow[];
  teams: TeamRow[];
  currentUserRole: MemberRole;
} | null> {
  const workspace = await fetchJson<ApiWorkspace>("/workspaces/active", request);
  const members = await fetchJson<MemberRow[]>("/members", request);
  if (!workspace || !members) return null;

  const currentMember = members.find((member) => member.userId === currentUserId);
  if (!currentMember) return null;

  const pendingInvitations =
    (await fetchJson<PendingInvitationRow[]>("/workspace/invitations", request)) ?? [];
  const teamsResponse = await fetchJson<PaginatedTeams>("/teams?pageSize=100", request);
  const teams = teamsResponse?.items ?? [];

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
      planSeats: workspace.planSeats,
    },
    members,
    pendingInvitations,
    teams,
    currentUserRole: currentMember.role,
  };
}

export async function createInvitation(
  workspaceId: string,
  email: string,
  role: InvitationRole,
): Promise<PendingInvitationRow> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspaces/${workspaceId}/invitations`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const body = (await res.json()) as {
    id: string;
    invitedEmail: string;
    role: InvitationRole;
    invitedByUserId: string;
    expiresAt: string;
  };
  return {
    id: body.id,
    invitedEmail: body.invitedEmail,
    role: body.role,
    invitedByName: "",
    expiresAt: body.expiresAt,
  };
}

export async function updateMemberRole(
  userId: string,
  role: MemberRole,
): Promise<MemberRow> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/members/${userId}`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as MemberRow;
}

export async function removeMember(userId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/members/${userId}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function transferOwnership(targetUserId: string): Promise<MemberRow[]> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/members/transfer-ownership`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ targetUserId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as MemberRow[];
}

export async function resendInvitation(invitationId: string): Promise<PendingInvitationRow> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace/invitations/${invitationId}/resend`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as PendingInvitationRow;
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspace/invitations/${invitationId}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function createTeam(name: string, description: string): Promise<TeamRow> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/teams`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ name, description: description || null }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as TeamRow;
}

export async function deleteTeam(teamId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/teams/${teamId}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function addTeamMember(teamId: string, userId: string): Promise<TeamRow> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/teams/${teamId}/members`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as TeamRow;
}

export async function removeTeamMember(teamId: string, userId: string): Promise<TeamRow> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/teams/${teamId}/members/${userId}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as TeamRow;
}
