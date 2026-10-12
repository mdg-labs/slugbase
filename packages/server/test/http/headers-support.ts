import { expect } from "vitest";

/** The directive names of a `Content-Security-Policy` value, in order, repeats kept. */
export function directiveNamesOf(policy: string): string[] {
  return policy
    .split(";")
    .map((part) => part.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
    .filter((name) => name !== "");
}

/** The directives of a `Content-Security-Policy` value, by name; a repeated directive keeps its first value, as a browser does. */
export function directivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "" && !directives.has(name.toLowerCase())) {
      directives.set(name.toLowerCase(), sources);
    }
  }
  return directives;
}

/** The only sources a script directive may carry; a keyword is matched case-insensitively, as a browser does. */
const SCRIPT_SOURCE = /^(?:'self'|'none'|'nonce-[^']+'|'sha(?:256|384|512)-[^']+')$/i;

/**
 * The header set every response carries (doc 01 section 4 step 2). A policy that
 * lets the app be framed, or allows an inline script or `eval`, fails here.
 */
export function expectSecurityHeaders(headers: Headers, options: { readonly https: boolean }): void {
  const policy = headers.get("content-security-policy");
  expect(policy, "Content-Security-Policy").not.toBeNull();
  expect(directiveNamesOf(policy ?? "").sort(), "the directives of the policy, each once").toEqual(
    ["base-uri", "default-src", "frame-ancestors", "img-src", "object-src", "script-src"],
  );
  const directives = directivesOf(policy ?? "");
  expect(directives.get("default-src")).toEqual(["'self'"]);
  expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  expect(directives.get("img-src")).toEqual(["'self'", "data:"]);
  expect(directives.get("object-src")).toEqual(["'none'"]);
  expect(directives.get("base-uri")).toEqual(["'self'"]);
  for (const name of ["default-src", "script-src", "script-src-elem", "script-src-attr"]) {
    const sources =
      directives.get(name) ??
      (name.startsWith("script-src-") ? directives.get("script-src") : undefined) ??
      directives.get("default-src") ??
      [];
    const forbidden = sources.filter((source) => !SCRIPT_SOURCE.test(source));
    expect(forbidden, `${name} sources outside 'self', 'none', a nonce or a hash`).toEqual([]);
  }

  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  if (options.https) {
    expect(headers.get("strict-transport-security")).toBe("max-age=31536000");
  } else {
    expect(headers.get("strict-transport-security")).toBeNull();
  }
  expect([...headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
}
