/** Route prefixes where Session Replay must not record (SEC-026). */
const SENSITIVE_REPLAY_PREFIXES = [
  "/login",
  "/register",
  "/mfa",
  "/setup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/verify-email-change",
  "/settings",
] as const;

export function isSensitiveReplayRoute(pathname: string): boolean {
  return SENSITIVE_REPLAY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
