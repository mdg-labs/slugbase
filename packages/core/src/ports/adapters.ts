import type { AiSuggestPort } from "./ai-suggest.ts";
import type { AnalyticsPort } from "./analytics.ts";
import type { ChallengePort } from "./challenge.ts";
import type { ClientErrorReportPort } from "./client-error-report.ts";
import type { EgressPort } from "./egress.ts";
import type { EntitlementSource } from "./entitlements.ts";
import type { ErrorReportPort } from "./error-report.ts";
import type { IdentityPort } from "./identity.ts";
import type { MailPort } from "./mail.ts";
import type { RateLimitPort } from "./rate-limit.ts";
import type { SecretBoxPort } from "./secret-box.ts";
import type { TenantResolver } from "./tenant-resolver.ts";

/**
 * The adapter selected for each port: the `adapters` argument of `createServer`
 * (doc 01 section 7.1). `BillingPort` joins the map with the first Cloud billing
 * operation.
 */
export interface Adapters {
  readonly mail: MailPort;
  readonly ai: AiSuggestPort;
  readonly identity: IdentityPort;
  readonly analytics: AnalyticsPort;
  readonly errors: ErrorReportPort;
  readonly clientErrorReport: ClientErrorReportPort;
  readonly challenge: ChallengePort;
  readonly egress: EgressPort;
  readonly rateLimit: RateLimitPort;
  readonly secretBox: SecretBoxPort;
  readonly tenantResolver: TenantResolver;
  readonly entitlements: EntitlementSource;
}
