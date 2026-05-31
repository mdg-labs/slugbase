import type { LoaderFunctionArgs } from "react-router";

import { loadDashboardData } from "../../components/dashboard/dashboard-loader.js";
import { DashboardPage } from "../../components/dashboard/DashboardPage.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadDashboardData(request);
  if (!data) {
    throw new Error("Failed to load dashboard data");
  }
  return data;
}

export default function DashboardRoute() {
  return <DashboardPage />;
}
