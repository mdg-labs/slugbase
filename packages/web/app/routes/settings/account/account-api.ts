import {
  apiFetch,
  parseApiErrorMessage,
  serverFetchJson,
} from "../../../lib/client-api-fetch.js";
import type {
  AccountSettingsData,
  ApiTokenSummary,
  UpdateAccountEmailBody,
  UpdateAccountPasswordBody,
  UpdateAccountPreferencesBody,
  UpdateAccountProfileBody,
} from "./account.types.js";

export async function loadAccountSettings(
  request: Request,
): Promise<AccountSettingsData | null> {
  return serverFetchJson<AccountSettingsData>(request, "/auth/account");
}

export async function refreshAccountSettings(): Promise<AccountSettingsData | null> {
  const res = await apiFetch("/auth/account");
  if (!res.ok) return null;
  return (await res.json()) as AccountSettingsData;
}

export async function updateAccountProfile(
  body: UpdateAccountProfileBody,
): Promise<AccountSettingsData> {
  const res = await apiFetch("/auth/account/profile", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function updateAccountPassword(
  body: UpdateAccountPasswordBody,
): Promise<void> {
  const res = await apiFetch("/auth/account/password", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function updateAccountPreferences(
  body: UpdateAccountPreferencesBody,
): Promise<AccountSettingsData> {
  const res = await apiFetch("/auth/account/preferences", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function requestAccountEmailChange(
  body: UpdateAccountEmailBody,
): Promise<AccountSettingsData> {
  const res = await apiFetch("/auth/account/email", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function resendAccountEmailChange(): Promise<void> {
  const res = await apiFetch("/auth/account/email/resend", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function cancelAccountEmailChange(): Promise<AccountSettingsData> {
  const res = await apiFetch("/auth/account/email/pending", {
    method: "DELETE",
    csrf: true,
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as AccountSettingsData;
}

export async function listApiTokens(request?: Request): Promise<ApiTokenSummary[]> {
  const data = request
    ? await serverFetchJson<{ tokens: ApiTokenSummary[] }>(request, "/auth/api-tokens")
    : await apiFetch("/auth/api-tokens").then(async (res: Response) =>
        res.ok ? ((await res.json()) as { tokens: ApiTokenSummary[] }) : null,
      );
  return data?.tokens ?? [];
}

export async function createApiToken(name: string): Promise<{
  token: ApiTokenSummary;
  plaintext: string;
}> {
  const res = await apiFetch("/auth/api-tokens", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as { token: ApiTokenSummary; plaintext: string };
}

export async function revokeApiToken(id: string): Promise<void> {
  const res = await apiFetch(`/auth/api-tokens/${id}`, {
    method: "DELETE",
    csrf: true,
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export interface MfaEnrolStartData {
  otpAuthUri: string;
  textSecret: string;
  qrDataUri: string;
}

export async function startMfaEnrol(): Promise<MfaEnrolStartData> {
  const res = await apiFetch("/auth/mfa/enrol/start", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as MfaEnrolStartData;
}

export async function confirmMfaEnrol(totpCode: string): Promise<string[]> {
  const res = await apiFetch("/auth/mfa/enrol/confirm", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const data = (await res.json()) as { backupCodes: string[] };
  return data.backupCodes;
}

export async function disableMfa(totpCode: string): Promise<void> {
  const res = await apiFetch("/auth/mfa/disable", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function regenerateMfaBackupCodes(totpCode: string): Promise<string[]> {
  const res = await apiFetch("/auth/mfa/backup-codes/regenerate", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const data = (await res.json()) as { backupCodes: string[] };
  return data.backupCodes;
}
