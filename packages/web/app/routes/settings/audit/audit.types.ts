export type AuditEventType =
  | "bookmark"
  | "folder"
  | "tag"
  | "member"
  | "team"
  | "settings"
  | "auth";

export type AuditEvent = {
  id: string;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorInitials: string;
  action: string;
  entity: string;
  entitySuffix?: string;
  type: AuditEventType;
};

export type AuditActor = {
  id: string;
  name: string;
};

export type AuditEventsPage = {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  actors: AuditActor[];
};

export type WorkspaceMemberRole = "OWNER" | "ADMIN" | "MEMBER";

export type WorkspacePlanSummary = {
  id: string;
  plan: "free" | "personal" | "team";
};

export type AuditLoaderData = {
  currentUserRole: WorkspaceMemberRole;
  workspace: WorkspacePlanSummary | null;
  events: AuditEventsPage | null;
  roleDenied: boolean;
  planDenied: boolean;
  loadError: boolean;
};

export const AUDIT_EVENT_TYPES: AuditEventType[] = [
  "bookmark",
  "folder",
  "tag",
  "member",
  "team",
  "settings",
  "auth",
];

export const AUDIT_PAGE_SIZE = 8;
