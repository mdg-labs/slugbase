import { Inject, Injectable } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorage,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
} from "@nestjs/throttler";
import type { Response } from "express";

import { SESSION_COOKIE } from "../login-logout.controller.js";
import { SessionService } from "../../sessions/session.service.js";

/**
 * Session-scoped rate-limit guard for token creation endpoints.
 * Uses the verified session ID as the throttle key, which uniquely identifies a
 * user session. Falls back to IP for unauthenticated requests (the auth guard
 * will reject those anyway).
 *
 * Backed by an in-memory store — suitable for single-instance deployments.
 * Fast-Follow: switch to a distributed store (Redis/KV) for multi-instance deployments.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {
    super(options, storageService, reflector);
  }

  protected override getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const rawCookie = (
      req as { cookies?: Record<string, string> }
    ).cookies?.[SESSION_COOKIE];

    if (rawCookie) {
      const sessionId = this.sessions.verifySessionCookie(rawCookie);
      if (sessionId) {
        return Promise.resolve(`session:${sessionId}`);
      }
    }

    // Fallback to IP — the session auth guard will reject the request anyway
    return Promise.resolve((req as { ip?: string }).ip ?? "unknown");
  }

  /** Adds the standard RFC 7231 Retry-After header (seconds) on throttle. */
  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader("Retry-After", Math.ceil(detail.timeToBlockExpire / 1000));
    return Promise.reject(new ThrottlerException());
  }
}
