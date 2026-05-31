import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";

/** Session cookie name — must match the backend constant. */
const SESSION_COOKIE = "slb_session";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

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
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return response;
}

/** GET /logout: redirect to /login (no session to check on direct navigation). */
export function loader() {
  return redirect("/login");
}

export default function LogoutRoute() {
  return null;
}
