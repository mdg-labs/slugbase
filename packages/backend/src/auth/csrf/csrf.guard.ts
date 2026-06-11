import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { CsrfService } from "./csrf.service.js";
import { SKIP_CSRF_KEY } from "./skip-csrf.decorator.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CsrfService) private readonly csrfService: CsrfService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip CSRF in e2e mode — no real cross-origin threat
    if (process.env.SLUGBASE_E2E_MODE === "true") return true;

    const req = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(req.method)) return true;

    // Bearer token requests carry implicit CSRF protection - custom Authorization
    // headers cannot be auto-set by cross-origin forms or browser navigation.
    if (req.headers.authorization?.startsWith("Bearer ")) return true;

    const skipCsrf = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipCsrf) return true;

    const rawHeader = req.headers[CSRF_HEADER];
    const headerToken =
      typeof rawHeader === "string" ? rawHeader : rawHeader?.[0];
    const cookieToken = req.cookies[CSRF_COOKIE] as string | undefined;

    if (
      !headerToken ||
      !cookieToken ||
      headerToken !== cookieToken ||
      !this.csrfService.verifyToken(headerToken)
    ) {
      throw new ForbiddenException("CSRF token invalid or missing");
    }

    return true;
  }
}
