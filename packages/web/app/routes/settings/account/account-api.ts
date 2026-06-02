import type {
  AccountSettingsData,
  ApiTokenSummary,
  UpdateAccountEmailBody,
  UpdateAccountPasswordBody,
  UpdateAccountPreferencesBody,
  UpdateAccountProfileBody,
} from "./account.types.js";

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

export async function loadAccountSettings(
  request: Request,
): Promise<AccountSettingsData | null> {
  return fetchJson<AccountSettingsData>("/auth/account", request);
}

export async function updateAccountProfile(
  body: UpdateAccountProfileBody,
): Promise<AccountSettingsData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/account/profile`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function updateAccountPassword(
  body: UpdateAccountPasswordBody,
): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/account/password`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function updateAccountPreferences(
  body: UpdateAccountPreferencesBody,
): Promise<AccountSettingsData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/account/preferences`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function requestAccountEmailChange(
  body: UpdateAccountEmailBody,
): Promise<AccountSettingsData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/account/email`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function resendAccountEmailChange(): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/account/email/resend`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function cancelAccountEmailChange(): Promise<AccountSettingsData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/account/email/pending`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function listApiTokens(request?: Request): Promise<ApiTokenSummary[]> {
  const data = await fetchJson<{ tokens: ApiTokenSummary[] }>(
    "/auth/api-tokens",
    request,
  );
  return data?.tokens ?? [];
}

export async function createApiToken(name: string): Promise<{
  token: ApiTokenSummary;
  plaintext: string;
}> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/api-tokens`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as { token: ApiTokenSummary; plaintext: string };
}

export async function revokeApiToken(id: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/api-tokens/${id}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export interface MfaEnrolStartData {
  otpAuthUri: string;
  textSecret: string;
  qrDataUri: string;
}

export async function startMfaEnrol(): Promise<MfaEnrolStartData> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/mfa/enrol/start`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as MfaEnrolStartData;
}

export async function confirmMfaEnrol(totpCode: string): Promise<string[]> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/mfa/enrol/confirm`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const data = (await res.json()) as { backupCodes: string[] };
  return data.backupCodes;
}

export async function disableMfa(totpCode: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/mfa/disable`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function regenerateMfaBackupCodes(totpCode: string): Promise<string[]> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/auth/mfa/backup-codes/regenerate`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const data = (await res.json()) as { backupCodes: string[] };
  return data.backupCodes;
}
