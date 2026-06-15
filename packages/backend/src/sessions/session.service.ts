import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";
import { DbService } from "../db/db.service.js";
import { SessionRepository } from "./session.repository.js";
import type { CreateSessionOptions, SessionRecord } from "./session.types.js";

const HMAC_ALGORITHM = "sha256";
const COOKIE_SEPARATOR = ".";
const DAYS_TO_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SessionService {
  private readonly repo: SessionRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.repo = new SessionRepository(db.getOrm());
  }

  private get sessionSecret(): string {
    return this.config.get("SESSION_SECRET");
  }

  private get ttlMs(): number {
    return this.config.get("SESSION_TTL_DAYS") * DAYS_TO_MS;
  }

  private get rememberTtlMs(): number {
    return this.config.get("SESSION_REMEMBER_TTL_DAYS") * DAYS_TO_MS;
  }

  private ttlMsForSessionData(data: Record<string, unknown>): number {
    return data["rememberMe"] === true ? this.rememberTtlMs : this.ttlMs;
  }

  /** Signs a session ID with HMAC and returns the cookie value. */
  signSessionId(sessionId: string): string {
    const mac = createHmac(HMAC_ALGORITHM, this.sessionSecret)
      .update(sessionId)
      .digest("base64url");
    return `${sessionId}${COOKIE_SEPARATOR}${mac}`;
  }

  /** Verifies the HMAC in a cookie value. Returns the session ID or null. */
  verifySessionCookie(cookieValue: string): string | null {
    const idx = cookieValue.lastIndexOf(COOKIE_SEPARATOR);
    if (idx === -1) return null;

    const sessionId = cookieValue.slice(0, idx);
    const mac = cookieValue.slice(idx + 1);

    const expected = createHmac(HMAC_ALGORITHM, this.sessionSecret)
      .update(sessionId)
      .digest();
    const macBuf = Buffer.from(mac, "base64url");

    if (macBuf.length !== expected.length) return null;
    if (!timingSafeEqual(macBuf, expected)) return null;
    return sessionId;
  }

  /** Creates a new session and returns the session ID and signed cookie value. */
  async createSession(
    options: CreateSessionOptions,
  ): Promise<{ sessionId: string; cookieValue: string }> {
    const sessionId = randomBytes(16).toString("hex");
    const nowMs = Date.now();
    const ttlMs =
      options.ttlDays !== undefined
        ? options.ttlDays * DAYS_TO_MS
        : this.ttlMs;
    const expiresAtMs = nowMs + ttlMs;
    const data = JSON.stringify(options.data ?? {});

    await this.repo.create(sessionId, options.userId, expiresAtMs, nowMs, data);

    return { sessionId, cookieValue: this.signSessionId(sessionId) };
  }

  /** Looks up a session by ID. Returns null if not found or expired. */
  async findSession(sessionId: string): Promise<SessionRecord | null> {
    const record = await this.repo.findById(sessionId);
    if (!record) return null;

    if (record.expiresAt <= new Date()) {
      await this.repo.deleteById(sessionId);
      return null;
    }

    return record;
  }

  /** Extends session TTL (sliding window). */
  async touchSession(sessionId: string): Promise<void> {
    const record = await this.repo.findById(sessionId);
    if (!record) return;

    const nowMs = Date.now();
    const ttlMs = this.ttlMsForSessionData(record.data);
    await this.repo.touch(sessionId, nowMs + ttlMs, nowMs);
  }

  /** Revokes a single session. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.repo.deleteById(sessionId);
  }

  /** Revokes all sessions for a user (log-out-everywhere). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.repo.deleteAllByUserId(userId);
  }

  /** Replaces the data payload of an existing session. */
  async updateSessionData(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.repo.updateData(sessionId, JSON.stringify(data), Date.now());
  }
}
