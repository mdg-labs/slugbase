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
