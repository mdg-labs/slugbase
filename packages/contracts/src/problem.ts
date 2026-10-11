import { z } from "zod";

/**
 * Every problem `code` and the one HTTP status it answers with (doc 04 section 3.2).
 * Several codes may share a status; a code never has two.
 */
export const PROBLEM_CATALOG = [
  { status: 400, code: "bad_request" },
  { status: 401, code: "unauthenticated" },
  { status: 401, code: "mfa_required" },
  { status: 401, code: "reauth_required" },
  { status: 403, code: "forbidden" },
  { status: 403, code: "registration_refused" },
  { status: 403, code: "cross_site_request" },
  { status: 403, code: "token_scope" },
  { status: 403, code: "entitlement_required" },
  { status: 403, code: "email_unverified" },
  { status: 403, code: "registration_closed" },
  { status: 403, code: "setup_completed" },
  { status: 404, code: "not_found" },
  { status: 404, code: "slug_not_found" },
  { status: 409, code: "slug_taken" },
  { status: 409, code: "name_taken" },
  { status: 409, code: "email_taken" },
  { status: 409, code: "already_member" },
  { status: 409, code: "last_owner" },
  { status: 409, code: "idempotency_conflict" },
  { status: 409, code: "billing_active" },
  { status: 410, code: "token_expired" },
  { status: 412, code: "precondition_failed" },
  { status: 413, code: "payload_too_large" },
  { status: 415, code: "unsupported_media_type" },
  { status: 422, code: "validation_failed" },
  { status: 422, code: "bookmark_limit_reached" },
  { status: 422, code: "seat_limit_reached" },
  { status: 422, code: "workspace_limit_reached" },
  { status: 422, code: "weak_password" },
  { status: 422, code: "invalid_code" },
  { status: 422, code: "url_not_allowed" },
  { status: 429, code: "rate_limited" },
  { status: 500, code: "internal" },
  { status: 502, code: "upstream_failed" },
  { status: 503, code: "unavailable" },
  { status: 503, code: "mail_unavailable" },
  { status: 503, code: "ai_unavailable" },
  { status: 503, code: "billing_unavailable" },
] as const;

export type ProblemCode = (typeof PROBLEM_CATALOG)[number]["code"];
export type ProblemStatus = (typeof PROBLEM_CATALOG)[number]["status"];

const PROBLEM_CODES = PROBLEM_CATALOG.map((entry) => entry.code) as [ProblemCode, ...ProblemCode[]];

const STATUS_BY_CODE: ReadonlyMap<ProblemCode, ProblemStatus> = new Map(
  PROBLEM_CATALOG.map((entry) => [entry.code, entry.status]),
);

export const ProblemCodeSchema = z.enum(PROBLEM_CODES);

/** The HTTP status a problem code answers with. */
export function problemStatus(code: ProblemCode): ProblemStatus {
  const status = STATUS_BY_CODE.get(code);
  if (status === undefined) {
    throw new Error(`unknown problem code: ${code}`);
  }
  return status;
}

export const ProblemFieldErrorSchema = z
  .object({
    path: z.string().describe("Location of the field in the request body"),
    code: z.string().describe("Field-level code, such as too_short or slug_taken"),
  })
  .meta({ id: "ProblemFieldError" });

/**
 * An RFC 9457 problem document (doc 04 section 3.1). Codes with extra members
 * (limit, used, entitlement, upgradeAvailable) add them beside these fields, so
 * the object is open.
 */
export const ProblemSchema = z
  .looseObject({
    type: z.string().describe("URL form of the code"),
    title: z.string().describe("Static English title for the code"),
    status: z.number().int().min(100).max(599).describe("HTTP status of the response"),
    code: ProblemCodeSchema.meta({ "x-extensible-enum": true }).describe("Stable machine identifier"),
    detail: z.string().describe("English explanation; may contain user-supplied values"),
    requestId: z.string().describe("Echo of the X-Request-Id response header"),
    errors: z.array(ProblemFieldErrorSchema).optional().describe("Per-field errors"),
  })
  .meta({ id: "Problem" });

export type Problem = z.infer<typeof ProblemSchema>;
