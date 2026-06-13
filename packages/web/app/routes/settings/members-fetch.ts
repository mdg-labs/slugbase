import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

export interface ApiMember {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}

export interface MembersFetchResult<T = ApiMember> {
  members: T[] | null;
  forbidden: boolean;
}

/**
 * Fetch the workspace member list with 403 fallback.
 *
 * On the hosted Free plan the `team-admin` entitlement may not be granted,
 * which caused a 403 on `GET /members` before the entitlement gate was
 * removed from the read path. This helper keeps working even if the 403
 * reappears - callers degrade gracefully instead of throwing 500s.
 */
export async function fetchMembersWithFallback<T = ApiMember>(
  request: Request,
): Promise<MembersFetchResult<T>> {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getServerApiBaseUrl()}/members`, {
      headers: cookie ? { Cookie: cookie } : {},
      credentials: undefined,
    });
    if (res.status === 403) {
      return { members: null, forbidden: true };
    }
    if (!res.ok) {
      return { members: null, forbidden: false };
    }
    const data = (await res.json()) as T[];
    return { members: data, forbidden: false };
  } catch {
    return { members: null, forbidden: false };
  }
}
