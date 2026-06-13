import type {
  ShareGrant,
  ShareResourceKind,
  ShareTargets,
} from "./sharing.types.js";

const getApiBaseUrl = (): string => {
  const fromProcess = typeof process !== "undefined" ? process.env["API_BASE_URL"] : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess.replace(/\/$/, "");
  const fromVite = typeof import.meta !== "undefined" ? (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL : undefined;
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite.replace(/\/$/, "");
  return "";
};

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string };
    return data.message ?? "Request failed";
  } catch {
    return "Request failed";
  }
}

export async function fetchShareTargets(): Promise<ShareTargets> {
  const res = await fetch(`${getApiBaseUrl()}/sharing/targets`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as ShareTargets;
}

export async function fetchResourceShares(
  resourceKind: ShareResourceKind,
  resourceId: string,
): Promise<ShareGrant[]> {
  const res = await fetch(`${getApiBaseUrl()}/sharing/${resourceKind}s/${resourceId}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const data = (await res.json()) as { grants: ShareGrant[] };
  return data.grants;
}

export async function grantResourceShare(
  resourceKind: ShareResourceKind,
  resourceId: string,
  kind: "user" | "team",
  targetId: string,
): Promise<ShareGrant> {
  const res = await fetch(
    `${getApiBaseUrl()}/sharing/${resourceKind}s/${resourceId}/grants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ kind, targetId }),
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as ShareGrant;
}

export async function revokeResourceShare(
  resourceKind: ShareResourceKind,
  resourceId: string,
  grantId: string,
): Promise<void> {
  const res = await fetch(
    `${getApiBaseUrl()}/sharing/${resourceKind}s/${resourceId}/grants/${grantId}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
}

export async function fetchShareTargetsFromRequest(
  request: Request,
  apiBaseUrl: string,
): Promise<ShareTargets | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${apiBaseUrl}/sharing/targets`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as ShareTargets;
  } catch {
    return null;
  }
}
