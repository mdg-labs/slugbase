import { useLoaderData } from "react-router";

import type { AuditLoaderData } from "./audit.types.js";
import { AuditLogPage } from "./components/AuditLogPage.js";
import { AuditPlanGate } from "./components/AuditPlanGate.js";

export { auditSettingsLoader as loader } from "./audit-loader.js";

export default function AuditSettingsRoute() {
  const { canAccess, events } = useLoaderData<AuditLoaderData>();

  if (!canAccess) {
    return <AuditPlanGate />;
  }

  if (!events) {
    return <AuditPlanGate />;
  }

  return <AuditLogPage events={events} />;
}
