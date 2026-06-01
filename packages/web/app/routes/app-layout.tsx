import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { AppChrome } from "../components/AppChrome.js";
import { getSessionUser } from "../lib/session-client.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

async function fetchActiveWorkspace(request: Request) {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getApiBaseUrl()}/workspaces/active`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      id: string;
      name: string;
      plan: "free" | "personal" | "team";
    };
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (!user) return redirect("/login");

  const workspace = await fetchActiveWorkspace(request);
  if (!workspace) {
    throw new Error("Failed to load active workspace");
  }

  return { user, workspace };
}

export default function AppLayoutRoute() {
  return <AppChrome />;
}

export { AppShellErrorBoundary as ErrorBoundary } from "./errors/AppShellErrorBoundary.js";
