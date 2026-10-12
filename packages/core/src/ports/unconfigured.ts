import type { Adapters } from "./adapters.js";
import { PortUnavailable, type PortUnavailableCode } from "./port.js";

function unavailable(port: keyof Adapters, code: PortUnavailableCode = "unavailable"): () => Promise<never> {
  return () => Promise.reject(new PortUnavailable(port, code));
}

/**
 * The adapters of an instance with nothing configured (D22): every port reports
 * `available: false`. Mail, AI, identity, egress, the secret box, the rate
 * limiter and the tenant resolver reject with `PortUnavailable` when used, so a
 * missing adapter never reads as success. Analytics and error reporting record
 * nothing, and the challenge is disabled: it requires no solution and passes
 * every one.
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
    challenge: { available: false, verify: () => Promise.resolve({ ok: true }) },
    egress: { available: false, request: unavailable("egress") },
    rateLimit: { available: false, consume: unavailable("rateLimit") },
    secretBox: { available: false, seal: unavailable("secretBox"), open: unavailable("secretBox") },
    tenantResolver: { available: false, resolve: unavailable("tenantResolver") },
  };
}
