import { Injectable } from "@nestjs/common";
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

/**
 * IP-based rate-limit guard for auth endpoints (login, register, MFA challenge).
 * Uses the client IP address as the throttle key.
 *
 * Backed by an in-memory store - suitable for single-instance deployments.
 * Fast-Follow: switch to a distributed store (Redis/KV) for multi-instance deployments.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected override getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const r = req as { ip?: string; ips?: string[] };
    // Prefer the first forwarded IP (set by express when trust proxy is configured)
    return Promise.resolve(r.ips?.[0] ?? r.ip ?? "unknown");
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
