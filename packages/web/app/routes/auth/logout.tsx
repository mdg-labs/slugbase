import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";
import { redirect } from "react-router";
import { authCookieSecure } from "../../lib/api-session-cookie.js";

/** Session cookie name - must match the backend constant. */
const SESSION_COOKIE = "slb_session";

const API_BASE_URL = () => getServerApiBaseUrl();

function clearSessionCookie(response: Response): void {
  const flags = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (authCookieSecure()) {
    flags.push("Secure");
  }
  response.headers.set("Set-Cookie", flags.join("; "));
}

async function revokeServerSession(cookie: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL()}/auth/logout`, {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
    });
  } catch {
    // Proceed to clear the cookie even if the backend call fails so the
    // client session is always cleaned up on logout.
  }
}

async function signOut(request: Request): Promise<Response> {
  const cookie = request.headers.get("Cookie") ?? "";
  await revokeServerSession(cookie);

  const response = redirect("/login");
  clearSessionCookie(response);
  return response;
}

export async function action({ request }: ActionFunctionArgs) {
  return signOut(request);
}

/** GET /logout: revokes the server session and clears the cookie before
 *  redirecting to /login, so existing GET links/bookmarks still sign out. */
export async function loader({ request }: LoaderFunctionArgs) {
  return signOut(request);
}

export default function LogoutRoute() {
  return null;
}
