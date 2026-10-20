import type { Adapters } from "./adapters.ts";
import { PortUnavailable, type PortUnavailableCode } from "./port.ts";

function unavailable(port: keyof Adapters, code: PortUnavailableCode = "unavailable"): () => Promise<never> {
  return () => Promise.reject(new PortUnavailable(port, code));
}

/**
 * The adapters of an instance with nothing configured (D22): every port reports
 * `available: false`. Mail, AI, identity, egress, the secret box, the rate
 * limiter, the tenant resolver and the entitlement source reject with
 * `PortUnavailable` when used, so a missing adapter never reads as success (an
 * instance with no source holds no entitlement). Analytics and error reporting record
 * nothing, the client error-report source answers no DSN, and the challenge is
 * disabled: it requires no solution and passes every one.
 */
export function unconfigured(): Adapters {
  return {
    mail: { available: false, send: unavailable("mail", "mail_unavailable") },
    ai: { available: false, suggest: unavailable("ai", "ai_unavailable") },
    identity: {
      available: false,
      listProviders: unavailable("identity"),
      begin: unavailable("identity"),
      complete: unavailable("identity"),
    },
    analytics: { available: false, track: () => Promise.resolve() },
    errors: { available: false, capture: () => Promise.resolve() },
    clientErrorReport: { available: false, dsn: () => Promise.resolve(null) },
    challenge: { available: false, verify: () => Promise.resolve({ ok: true }) },
    egress: { available: false, request: unavailable("egress") },
    rateLimit: { available: false, consume: unavailable("rateLimit") },
    secretBox: {
      available: false,
      seal: unavailable("secretBox"),
      open: unavailable("secretBox"),
      needsRotation: unavailable("secretBox"),
      reseal: unavailable("secretBox"),
    },
    tenantResolver: { available: false, resolve: unavailable("tenantResolver") },
    entitlements: { available: false, forWorkspace: unavailable("entitlements"), forAccount: unavailable("entitlements") },
  };
}
