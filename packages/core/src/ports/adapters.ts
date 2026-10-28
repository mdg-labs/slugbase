import type { AiSuggestPort } from "./ai-suggest.ts";
import type { AnalyticsPort } from "./analytics.ts";
import type { BillingPort } from "./billing.ts";
import type { ChallengePort } from "./challenge.ts";
import type { ClientErrorReportPort } from "./client-error-report.ts";
import type { EgressPort } from "./egress.ts";
import type { EntitlementSource } from "./entitlements.ts";
import type { ErrorReportPort } from "./error-report.ts";
import type { IdentityPort } from "./identity.ts";
import type { ImageCodecPort } from "./image-codec.ts";
import type { MailPort } from "./mail.ts";
import type { RateLimitPort } from "./rate-limit.ts";
import type { SecretBoxPort } from "./secret-box.ts";
import type { TenantResolver } from "./tenant-resolver.ts";

/**
 * The adapter selected for each port: the `adapters` argument of `createServer`
 * (doc 01 section 7.1).
 */
export interface Adapters {
  readonly mail: MailPort;
  readonly ai: AiSuggestPort;
  readonly identity: IdentityPort;
  readonly analytics: AnalyticsPort;
  readonly billing: BillingPort;
  readonly errors: ErrorReportPort;
  readonly clientErrorReport: ClientErrorReportPort;
  readonly challenge: ChallengePort;
  readonly egress: EgressPort;
  readonly imageCodec: ImageCodecPort;
  readonly rateLimit: RateLimitPort;
  readonly secretBox: SecretBoxPort;
  readonly tenantResolver: TenantResolver;
  readonly entitlements: EntitlementSource;
}
