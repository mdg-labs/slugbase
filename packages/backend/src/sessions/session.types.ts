/**
 * Typed shape of the server-side session data payload (spec §4.3, §5.3).
 * All fields are optional; the session starts empty and is extended incrementally.
 */
export interface SessionData {
  /** Set during login when MFA is enrolled; cleared after successful challenge. */
  mfaPending?: boolean;
  /** Set when the account has not yet confirmed their email address. */
  emailVerificationPending?: boolean;
  /** The workspace the user has explicitly activated (spec §4.3). */
  activeWorkspaceId?: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  lastActivityAt: Date;
  data: Record<string, unknown>;
}

export interface CreateSessionOptions {
  userId: string;
  data?: Record<string, unknown>;
  /** Override TTL in days. Defaults to SESSION_TTL_DAYS config value. */
  ttlDays?: number;
}
