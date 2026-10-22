import type { Adapters } from "./adapters.ts";
import { PortUnavailable, type PortUnavailableCode } from "./port.ts";

function unavailable(port: keyof Adapters, code: PortUnavailableCode = "unavailable"): () => Promise<never> {
  return () => Promise.reject(new PortUnavailable(port, code));
}

/**
 * The adapters of an instance with nothing configured (D22): every port reports
 * `available: false`. Mail, AI, identity, billing, egress, the secret box, the
 * rate limiter, the tenant resolver and the entitlement source reject with
 * `PortUnavailable` when used, so a missing adapter never reads as success (an
 * instance with no source holds no entitlement; billing answers
 * `billing_unavailable`, except that its plan state is `none`). Analytics and error reporting record
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
    billing: {
      available: false,
      planState: () => Promise.resolve("none"),
      plans: unavailable("billing", "billing_unavailable"),
      legal: unavailable("billing", "billing_unavailable"),
      quote: unavailable("billing", "billing_unavailable"),
      startCheckout: unavailable("billing", "billing_unavailable"),
      checkoutState: unavailable("billing", "billing_unavailable"),
      previewChange: unavailable("billing", "billing_unavailable"),
      changeQuantity: unavailable("billing", "billing_unavailable"),
      changePlan: unavailable("billing", "billing_unavailable"),
      cancel: unavailable("billing", "billing_unavailable"),
      resume: unavailable("billing", "billing_unavailable"),
      updatePaymentMethod: unavailable("billing", "billing_unavailable"),
      updateBillingDetails: unavailable("billing", "billing_unavailable"),
      subscriptionDetails: unavailable("billing", "billing_unavailable"),
      customerDetails: unavailable("billing", "billing_unavailable"),
      listContracts: unavailable("billing", "billing_unavailable"),
      withdraw: unavailable("billing", "billing_unavailable"),
      listDocuments: unavailable("billing", "billing_unavailable"),
      documentPdf: unavailable("billing", "billing_unavailable"),
      receiveEvent: unavailable("billing", "billing_unavailable"),
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
