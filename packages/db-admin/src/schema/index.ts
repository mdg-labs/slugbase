export { adminSchema } from "./admin-schema.js";
export { dailySnapshots } from "./daily-snapshot.schema.js";
export { adminUsers } from "./admin-users.schema.js";
export { adminSessions } from "./admin-sessions.schema.js";
export { adminInvites } from "./admin-invites.schema.js";
export { auditEvents } from "./audit-events.schema.js";

import { adminInvites } from "./admin-invites.schema.js";
import { adminSessions } from "./admin-sessions.schema.js";
import { adminUsers } from "./admin-users.schema.js";
import { auditEvents } from "./audit-events.schema.js";
import { dailySnapshots } from "./daily-snapshot.schema.js";

export const adminTables = {
  dailySnapshots,
  adminUsers,
  adminSessions,
  adminInvites,
  auditEvents,
};

export type AdminTables = typeof adminTables;
