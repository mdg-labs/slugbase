import { useRouteLoaderData } from "react-router";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  language: "en" | "de";
  mfaState: "not_enrolled" | "pending" | "enrolled";
  emailVerified: boolean;
}

/** Server-side API base URL — available in Node loaders/actions at runtime. */
const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/**
 * Fetches the current session user from the backend by forwarding the session
 * cookie. Returns `null` when unauthenticated or the request fails.
 *
 * Designed for use in React Router v7 server-side loaders and actions.
 */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const apiBaseUrl = getApiBaseUrl();
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    const res = await fetch(`${apiBaseUrl}/auth/me`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionUser;
  } catch {
    return null;
  }
}

/**
 * React hook that reads the authenticated session user from the app-layout
 * loader data. Must be called from a route rendered inside the auth-guarded
 * app layout.
 */
export function useSession(): SessionUser {
  // useRouteLoaderData returns the serialized app-layout loader data
  const rawData: unknown = useRouteLoaderData("routes/app-layout");
  const data = rawData as { user: SessionUser } | undefined;
  if (!data?.user) {
    throw new Error("useSession must be used within an authenticated route");
  }
  return data.user;
}
