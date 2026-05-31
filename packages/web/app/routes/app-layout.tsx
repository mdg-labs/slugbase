import { redirect } from "react-router";
import type { Route } from "./+types/app-layout.js";
import { AppChrome } from "../components/AppChrome.js";
import { getSessionUser } from "../lib/session-client.js";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  if (!user) return redirect("/login");
  return { user };
}

export default function AppLayoutRoute() {
  return <AppChrome />;
}
