import type { AiSuggestPort } from "./ai-suggest.js";
import type { AnalyticsPort } from "./analytics.js";
import type { ChallengePort } from "./challenge.js";
import type { EgressPort } from "./egress.js";
import type { ErrorReportPort } from "./error-report.js";
import type { IdentityPort } from "./identity.js";
import type { MailPort } from "./mail.js";
import type { RateLimitPort } from "./rate-limit.js";
import type { SecretBoxPort } from "./secret-box.js";
import type { TenantResolver } from "./tenant-resolver.js";

/**
 * The adapter selected for each port: the `adapters` argument of `createServer`
 * (doc 01 section 7.1). `BillingPort` and `EntitlementSource` join the map with
 * the entitlement catalog.
 */
export interface Adapters {
  readonly mail: MailPort;
  readonly ai: AiSuggestPort;
  readonly identity: IdentityPort;
  readonly analytics: AnalyticsPort;
  readonly errors: ErrorReportPort;
  readonly challenge: ChallengePort;
  readonly egress: EgressPort;
  readonly rateLimit: RateLimitPort;
  readonly secretBox: SecretBoxPort;
  readonly tenantResolver: TenantResolver;
}
