import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";

/** Session cookie name - must match the backend constant. */
const SESSION_COOKIE = "slb_session";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";
const isProd = () => import.meta.env.PROD;

function clearSessionCookie(response: Response): void {
  const flags = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProd()) {
    flags.push("Secure");
  }
  response.headers.set("Set-Cookie", flags.join("; "));
}

export async function action({ request }: ActionFunctionArgs) {
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    await fetch(`${API_BASE_URL()}/auth/logout`, {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
    });
  } catch {
    // Proceed to clear the cookie even if the backend call fails so the
    // client session is always cleaned up on logout.
  }

  const response = redirect("/login");
  clearSessionCookie(response);
  return response;
}

/** GET /logout: also clears the session cookie before redirecting to /login,
 *  so existing GET links/bookmarks to /logout still result in a sign-out. */
export function loader() {
  const response = redirect("/login");
  clearSessionCookie(response);
  return response;
}

export default function LogoutRoute() {
  return null;
}
