import {
  apiFetch,
  parseApiErrorMessage,
  serverFetchJson,
} from "../../lib/client-api-fetch.js";
import type {
  ShareGrant,
  ShareResourceKind,
  ShareTargets,
} from "./sharing.types.js";

export async function fetchShareTargets(): Promise<ShareTargets> {
  const res = await apiFetch("/sharing/targets");
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as ShareTargets;
}

export async function fetchResourceShares(
  resourceKind: ShareResourceKind,
  resourceId: string,
): Promise<ShareGrant[]> {
  const res = await apiFetch(`/sharing/${resourceKind}s/${resourceId}`);
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
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
  const res = await apiFetch(
    `/sharing/${resourceKind}s/${resourceId}/grants`,
    {
      method: "POST",
      csrf: true,
      body: JSON.stringify({ kind, targetId }),
    },
  );
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as ShareGrant;
}

export async function revokeResourceShare(
  resourceKind: ShareResourceKind,
  resourceId: string,
  grantId: string,
): Promise<void> {
  const res = await apiFetch(
    `/sharing/${resourceKind}s/${resourceId}/grants/${grantId}`,
    { method: "DELETE", csrf: true },
  );
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function fetchShareTargetsFromRequest(
  request: Request,
): Promise<ShareTargets | null> {
  return serverFetchJson<ShareTargets>(request, "/sharing/targets");
}
