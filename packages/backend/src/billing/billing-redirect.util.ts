import { BadRequestException } from "@nestjs/common";

/**
 * Validates checkout redirect URLs against FRONTEND_ORIGIN (spec §11.4, §15).
 */
export function assertBillingRedirectUrlAllowed(
  redirectUrl: string,
  frontendOrigin: string,
  requireHttps: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    throw new BadRequestException("Invalid redirect URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException("Redirect URL must use HTTP or HTTPS");
  }

  if (requireHttps && parsed.protocol !== "https:") {
    throw new BadRequestException("Redirect URL must use HTTPS in production");
  }

  const allowedOrigin = new URL(frontendOrigin).origin;
  if (parsed.origin !== allowedOrigin) {
    throw new BadRequestException("Redirect URL must match the configured frontend origin");
  }
}
