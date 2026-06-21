export const ADMIN_SESSION_COOKIE = "slb_admin_session";

export interface AdminSessionUser {
  id: string;
  email: string;
  role: string;
}

export interface AdminSessionRecord {
  sessionId: string;
  user: AdminSessionUser;
}
