import { useLoaderData } from "react-router";

import type { AuditLoaderData } from "./audit.types.js";
import { AuditSettingsPage } from "./components/AuditSettingsPage.js";

export { auditSettingsLoader as loader } from "./audit-loader.js";

export default function AuditSettingsRoute() {
  const data = useLoaderData<AuditLoaderData>();
  return <AuditSettingsPage data={data} />;
}
