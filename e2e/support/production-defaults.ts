// The properties the audit rates the built image against (doc 10 section 6 rule 3, doc 08 section 5.1), as predicates: each takes what the
// journey read from the image (a Set-Cookie header, a header map, a probe body, the answer to a refused request) and returns the
// violations, an empty list when the property holds. They are pure so that production-defaults.test.ts can feed them a broken input
// without a stack. An input a predicate cannot classify is a violation, never a pass, and a violation names the property and the
// request, never a value that came from the image (a cookie's value, a token).

/** What the journey keeps of an answer: its status, its headers (names in lower case), every `Set-Cookie` and the parsed JSON body. */
export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly setCookies: readonly string[];
  readonly body: unknown;
}

/** The headers of an answer, by lower-case name. */
export type HeaderMap = Readonly<Record<string, string>>;

const SESSION_COOKIE_PREFIX = "__Host-";

// The values of Referrer-Policy that never send the path of a page to another site.
const PRIVATE_REFERRER_POLICIES: ReadonlySet<string> = new Set([
  "no-referrer",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function header(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/** The problem code of a body, or undefined where the body is not a problem document. */
function codeOf(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === "string" ? body.code : undefined;
}

function describeStatus(answer: Answer): string {
  return `status ${String(answer.status)}${codeOf(answer.body) === undefined ? "" : ` ${String(codeOf(answer.body))}`}`;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The violations of one `Set-Cookie` header against the session cookie (T4): `__Host-`, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. */
function cookieViolations(setCookie: string, index: number): string[] {
  const parts = setCookie.split(";").map((part) => part.trim());
  const pair = parts[0] ?? "";
  const separator = pair.indexOf("=");
  const name = separator > 0 ? pair.slice(0, separator).trim() : "";
  const which = `Set-Cookie ${String(index + 1)}`;
  if (name === "") {
    return [`${which} has no cookie name`];
  }
  // A browser applies the last of a repeated attribute (RFC 6265 section 5.3), so a repeat is a violation, whatever its values,
  // and the values below are those the browser would keep.
  const attributes = new Map<string, string>();
  const repeated = new Set<string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    const key = (equals === -1 ? part : part.slice(0, equals)).trim().toLowerCase();
    if (key === "") {
      continue;
    }
    if (attributes.has(key)) {
      repeated.add(key);
    }
    attributes.set(key, equals === -1 ? "" : part.slice(equals + 1).trim());
  }
  const violations: string[] = [...repeated].map((key) => `the cookie ${name} sets the ${key} attribute more than once`);
  if (!name.startsWith(SESSION_COOKIE_PREFIX)) {
    violations.push(`the cookie ${name} of ${which} does not start with ${SESSION_COOKIE_PREFIX}`);
  }
  if (!attributes.has("secure")) {
    violations.push(`the cookie ${name} is not Secure`);
  }
  if (!attributes.has("httponly")) {
    violations.push(`the cookie ${name} is not HttpOnly`);
  }
  if (attributes.get("samesite")?.toLowerCase() !== "lax") {
    violations.push(`the cookie ${name} does not have SameSite=Lax`);
  }
  if (attributes.get("path") !== "/") {
    violations.push(`the cookie ${name} does not have Path=/`);
  }
  if (attributes.has("domain")) {
    violations.push(`the cookie ${name} has a Domain attribute`);
  }
  return violations;
}

/** T4: the answer to a sign-in sets a session cookie, and every cookie it sets is a `__Host-` one with the attributes. */
export function sessionCookieViolations(setCookies: readonly string[]): string[] {
  if (setCookies.length === 0) {
    return ["the answer sets no session cookie"];
  }
  return setCookies.flatMap((setCookie, index) => cookieViolations(setCookie, index));
}

// The keyword sources that let script run that the policy is meant to keep out: inline script and event handlers, `eval`, the unsafe
// hashes of handlers, and WebAssembly compiled from a string (the app uses none).
const UNSAFE_KEYWORD_SOURCES: readonly string[] = ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'"];

// A scheme-only source (`https:`, `blob:`, `data:`) allows every address of that scheme.
const SCHEME_ONLY_SOURCE = /^[a-z][a-z0-9+.-]*:$/;

/** Why a source of a directive that governs scripts or workers is not allowed, or undefined where it is. Sources arrive in lower case. */
function unsafeSource(source: string): string | undefined {
  if (UNSAFE_KEYWORD_SOURCES.includes(source)) {
    return "is an unsafe keyword";
  }
  if (SCHEME_ONLY_SOURCE.test(source)) {
    return "allows every address of its scheme";
  }
  if (!source.startsWith("'") && source.includes("*")) {
    return "has a wildcard host";
  }
  return undefined;
}

/**
 * T5 and T14: what the Content-Security-Policy holds, judged exactly as follows.
 *
 * The directives that govern script are `script-src` (scripts), `script-src-elem` (script elements), `script-src-attr` (event handlers)
 * and `worker-src` (workers). Each one that applies is judged, where a directive applies when it is the first present of its
 * fallback chain: `script-src-elem` and `script-src-attr` then `script-src` then `default-src`; `script-src` then `default-src`;
 * `worker-src` then `child-src` then `script-src` then `default-src`. In a directive that applies, these sources are violations:
 * `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'` and `'wasm-unsafe-eval'`; a scheme-only source (`https:`, `blob:`, `data:`,
 * any `<scheme>:`); and a host source with a wildcard (`*`, `*.example.test`, `https://*`). Allowed are `'self'`, `'none'`, nonces,
 * hashes, `'strict-dynamic'` and explicit hosts without a wildcard. The policy needs `script-src` or `default-src`, and
 * `frame-ancestors 'none'`. A directive that appears twice is a violation, since a browser ignores the later one. Nothing else in the
 * policy is judged (`connect-src`, `img-src` and the rest may hold a scheme or a wildcard). A header that holds several policies,
 * joined by a comma, is judged policy by policy.
 */
export function cspViolations(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return ["the Content-Security-Policy is absent"];
  }
  return value.split(",").flatMap((policy) => {
    const directives = new Map<string, string[]>();
    const violations: string[] = [];
    const repeated = new Set<string>();
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name === undefined || name === "") {
        continue;
      }
      const key = name.toLowerCase();
      if (directives.has(key)) {
        repeated.add(key);
      } else {
        directives.set(key, sources.map((source) => source.toLowerCase()));
      }
    }
    for (const key of repeated) {
      violations.push(`the ${key} directive of the Content-Security-Policy appears more than once`);
    }
    if (!directives.has("script-src") && !directives.has("default-src")) {
      violations.push("the Content-Security-Policy has neither script-src nor default-src");
    }
    const governing = new Set<string>();
    for (const chain of [
      ["script-src", "default-src"],
      ["script-src-elem", "script-src", "default-src"],
      ["script-src-attr", "script-src", "default-src"],
      ["worker-src", "child-src", "script-src", "default-src"],
    ]) {
      const applies = chain.find((key) => directives.has(key));
      if (applies !== undefined) {
        governing.add(applies);
      }
    }
    for (const key of governing) {
      for (const source of directives.get(key) ?? []) {
        const reason = unsafeSource(source);
        if (reason !== undefined) {
          violations.push(`the ${key} of the Content-Security-Policy holds ${source}, which ${reason}`);
        }
      }
    }
    const ancestors = directives.get("frame-ancestors");
    if (ancestors === undefined) {
      violations.push("the Content-Security-Policy has no frame-ancestors");
    } else if (ancestors.length !== 1 || ancestors[0] !== "'none'") {
      violations.push("the frame-ancestors of the Content-Security-Policy is not 'none'");
    }
    return violations;
  });
}

/** T5 and T14: what the HTML of the app, a JSON answer of the API and a problem answer each carry. */
export function securityHeaderViolations(headers: HeaderMap): string[] {
  const violations = cspViolations(header(headers, "content-security-policy"));
  const hsts = header(headers, "strict-transport-security");
  const maxAge = hsts === undefined ? undefined : /(?:^|;)\s*max-age=(\d+)\s*(?:;|$)/i.exec(hsts)?.[1];
  if (maxAge === undefined || Number(maxAge) <= 0) {
    violations.push("Strict-Transport-Security is absent or has no max-age above zero");
  }
  if (header(headers, "cross-origin-opener-policy")?.trim().toLowerCase() !== "same-origin") {
    violations.push("Cross-Origin-Opener-Policy is not same-origin");
  }
  const referrer = header(headers, "referrer-policy")?.trim().toLowerCase();
  if (referrer === undefined || !PRIVATE_REFERRER_POLICIES.has(referrer)) {
    violations.push("Referrer-Policy is absent or sends the address of a page to other sites");
  }
  if (header(headers, "x-content-type-options")?.trim().toLowerCase() !== "nosniff") {
    violations.push("X-Content-Type-Options is not nosniff");
  }
  return violations;
}

/** An answer of the API or of /go that no cache may keep. */
export function noStoreViolations(headers: HeaderMap): string[] {
  const directives = (header(headers, "cache-control") ?? "").split(",").map((directive) => directive.trim().toLowerCase());
  return directives.includes("no-store") ? [] : ["Cache-Control does not hold no-store"];
}

/** An answer of /go: no-store, and the address of the page that follows the link is not sent on. */
export function goHeaderViolations(headers: HeaderMap): string[] {
  const violations = noStoreViolations(headers);
  if (header(headers, "referrer-policy")?.trim().toLowerCase() !== "no-referrer") {
    violations.push("Referrer-Policy is not no-referrer");
  }
  return violations;
}

/** T5: a request with the session cookie that breaks one rule (`label` names it) is refused `403 cross_site_request`. */
export function crossSiteRefusalViolations(label: string, answer: Answer): string[] {
  if (isSuccess(answer.status)) {
    return [`the request with ${label} was processed (status ${String(answer.status)}), not refused`];
  }
  if (answer.status !== 403 || codeOf(answer.body) !== "cross_site_request") {
    return [`the request with ${label} was answered ${describeStatus(answer)}, expected 403 cross_site_request`];
  }
  return [];
}

/** T5: the request that is meant to be processed (`label` names it) got the status it should. */
export function processedViolations(label: string, answer: Answer, expected: number): string[] {
  return answer.status === expected ? [] : [`the request with ${label} was answered ${describeStatus(answer)}, expected ${String(expected)}`];
}

/** T5: a bearer token that is not valid is answered `401`, so the session cookie that came with it is not used. */
export function unauthenticatedViolations(label: string, answer: Answer): string[] {
  if (answer.status !== 401 || codeOf(answer.body) !== "unauthenticated") {
    return [`the request with ${label} was answered ${describeStatus(answer)}, expected 401 unauthenticated`];
  }
  return [];
}

/** T5: a request that was refused wrote nothing; `listed` is what the account has afterwards. */
export function leakedBookmarks(refused: readonly string[], listed: readonly string[]): string[] {
  const present = new Set(listed);
  return refused.filter((url) => present.has(url)).map((url) => `a refused request created the bookmark ${url}`);
}

function probeCookieViolations(path: string, answer: Answer): string[] {
  return answer.setCookies.length === 0 ? [] : [`GET ${path} answered with a Set-Cookie`];
}

/** T22: `GET /health` answers `200` and exactly `{ "status": "ok" }`, and sets no cookie. */
export function healthViolations(answer: Answer): string[] {
  const violations = probeCookieViolations("/health", answer);
  if (answer.status !== 200) {
    violations.push(`GET /health answered status ${String(answer.status)}, expected 200`);
  }
  if (!isRecord(answer.body)) {
    violations.push("GET /health did not answer a JSON object");
    return violations;
  }
  const extra = Object.keys(answer.body).filter((key) => key !== "status");
  if (extra.length > 0) {
    violations.push(`GET /health answers more than its status: ${extra.sort().join(", ")}`);
  }
  if (answer.body.status !== "ok") {
    violations.push("GET /health does not answer status ok");
  }
  return violations;
}

const VERSION_KEYS = ["builtAt", "commit", "name", "version"];

/** T22: `GET /version` answers `200` and exactly `name`, `version`, `commit` and `builtAt`, each a non-empty string, and sets no cookie. */
export function versionViolations(answer: Answer): string[] {
  const violations = probeCookieViolations("/version", answer);
  if (answer.status !== 200) {
    violations.push(`GET /version answered status ${String(answer.status)}, expected 200`);
  }
  if (!isRecord(answer.body)) {
    violations.push("GET /version did not answer a JSON object");
    return violations;
  }
  const extra = Object.keys(answer.body).filter((key) => !VERSION_KEYS.includes(key));
  if (extra.length > 0) {
    violations.push(`GET /version answers more than ${VERSION_KEYS.join(", ")}: ${extra.sort().join(", ")}`);
  }
  for (const key of VERSION_KEYS) {
    const value = answer.body[key];
    if (typeof value !== "string" || value === "") {
      violations.push(`GET /version has no non-empty string ${key}`);
    }
  }
  return violations;
}

/** Doc 10 section 2.1: the setup endpoint of an instance with an account answers `403 setup_completed` and signs nobody in. */
export function setupClosedViolations(answer: Answer): string[] {
  const violations: string[] = [];
  if (answer.status !== 403 || codeOf(answer.body) !== "setup_completed") {
    violations.push(`POST /api/v1/setup was answered ${describeStatus(answer)}, expected 403 setup_completed`);
  }
  if (answer.setCookies.length > 0) {
    violations.push("POST /api/v1/setup answered with a Set-Cookie");
  }
  return violations;
}

/**
 * Doc 10 section 2.1: the refused setup created no account. `listed` is the `items` of `GET /api/v1/instance/accounts` after the refusal
 * (undefined when the answer was not a list) and `email` the address the refused setup sent. The instance's other accounts come and go
 * while other journeys run, so only the address of the refused setup is looked for, compared without regard to case.
 */
export function leakedAccounts(listed: readonly unknown[] | undefined, email: string): string[] {
  if (listed === undefined) {
    return ["the accounts of the instance could not be read"];
  }
  const wanted = email.toLowerCase();
  const found = listed.some((account) => typeof account === "object" && account !== null && String((account as { email?: unknown }).email).toLowerCase() === wanted);
  return found ? [`the instance lists an account with the address of the refused setup (${email})`] : [];
}
