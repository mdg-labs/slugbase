import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  crossSiteRefusalViolations,
  cspViolations,
  goHeaderViolations,
  healthViolations,
  leakedAccounts,
  leakedBookmarks,
  noStoreViolations,
  processedViolations,
  securityHeaderViolations,
  sessionCookieViolations,
  setupClosedViolations,
  unauthenticatedViolations,
  versionViolations,
  type Answer,
} from "./production-defaults.ts";

// The predicates of the production-defaults journey (tests/production-defaults.spec.ts): each takes what the journey read from the
// built image and returns the violations, an empty list when the property holds. Each is fed the shipped answer, which it accepts, and
// a broken one for every property it guards, which it reports: a predicate that accepted the broken one would let the regression
// through in the journey too. An input a predicate cannot classify is a violation, never a pass.

const SESSION_COOKIE = "__Host-slugbase_session=abc123; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure";
const CSP = "default-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=31536000",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

function without(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
}

function answer(status: number, body: unknown, setCookies: readonly string[] = []): Answer {
  return { status, headers: {}, setCookies, body };
}

void describe("the session cookie (T4)", () => {
  void it("accepts the cookie the server sets", () => {
    assert.deepEqual(sessionCookieViolations([SESSION_COOKIE]), []);
  });

  void it("accepts the attributes in another order and case", () => {
    assert.deepEqual(sessionCookieViolations(["__Host-s=v; secure; samesite=lax; httponly; path=/"]), []);
  });

  void it("reports a cookie without Secure", () => {
    const violations = sessionCookieViolations([SESSION_COOKIE.replace("; Secure", "")]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /Secure/);
  });

  void it("reports a cookie without the __Host- prefix", () => {
    const violations = sessionCookieViolations([SESSION_COOKIE.replace("__Host-", "")]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /__Host-/);
  });

  void it("reports a cookie without HttpOnly", () => {
    assert.match(sessionCookieViolations([SESSION_COOKIE.replace("; HttpOnly", "")]).join("\n"), /HttpOnly/);
  });

  void it("reports SameSite=None, SameSite=Strict and a missing SameSite", () => {
    assert.match(sessionCookieViolations([SESSION_COOKIE.replace("SameSite=Lax", "SameSite=None")]).join("\n"), /SameSite/);
    assert.match(sessionCookieViolations([SESSION_COOKIE.replace("SameSite=Lax", "SameSite=Strict")]).join("\n"), /SameSite/);
    assert.match(sessionCookieViolations([SESSION_COOKIE.replace("; SameSite=Lax", "")]).join("\n"), /SameSite/);
  });

  void it("reports a Path other than / and a missing Path", () => {
    assert.match(sessionCookieViolations([SESSION_COOKIE.replace("Path=/", "Path=/app")]).join("\n"), /Path/);
    assert.match(sessionCookieViolations([SESSION_COOKIE.replace("Path=/; ", "")]).join("\n"), /Path/);
  });

  void it("reports a Domain attribute", () => {
    assert.match(sessionCookieViolations([`${SESSION_COOKIE}; Domain=example.test`]).join("\n"), /Domain/);
  });

  void it("reports an answer that sets no cookie, an empty header and a header with no name", () => {
    assert.equal(sessionCookieViolations([]).length, 1);
    assert.ok(sessionCookieViolations([""]).length > 0);
    assert.ok(sessionCookieViolations(["; Path=/; HttpOnly; Secure; SameSite=Lax"]).length > 0);
  });

  void it("reports a repeated attribute, whatever its values, since the browser applies the last one", () => {
    const repeated = [
      `${SESSION_COOKIE}; SameSite=None`,
      `${SESSION_COOKIE}; SameSite=Lax`,
      `${SESSION_COOKIE}; samesite=none`,
      `${SESSION_COOKIE}; Path=/`,
      `${SESSION_COOKIE}; Path=/app`,
      `${SESSION_COOKIE}; Secure`,
      `${SESSION_COOKIE}; HTTPONLY`,
      `${SESSION_COOKIE}; Domain=example.test; domain=example.test`,
    ];
    for (const cookie of repeated) {
      const violations = sessionCookieViolations([cookie]);
      assert.ok(violations.some((violation) => /more than once/.test(violation)), cookie);
    }
    assert.ok(sessionCookieViolations(["__Host-s=v; Path=/; HttpOnly; Secure; SameSite=Lax; SameSite=None"]).length > 0);
  });

  void it("reads attribute names without regard to case when it looks for a repeat", () => {
    assert.match(sessionCookieViolations(["__Host-s=v; Path=/; HttpOnly; Secure; SameSite=Lax; SAMESITE=None"]).join("\n"), /SameSite.*more than once/i);
  });

  void it("judges every cookie of the answer", () => {
    assert.ok(sessionCookieViolations([SESSION_COOKIE, "other=1; Path=/"]).length > 0);
  });

  void it("never names the value of a cookie it reports", () => {
    const violations = sessionCookieViolations(["session=top-secret-value; Path=/"]);
    assert.ok(violations.length > 0);
    assert.ok(!violations.join("\n").includes("top-secret-value"));
  });
});

void describe("the content security policy (T5, T14)", () => {
  void it("accepts the policy the server sends", () => {
    assert.deepEqual(cspViolations(CSP), []);
  });

  void it("reports 'unsafe-inline' in script-src", () => {
    assert.match(cspViolations(CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")).join("\n"), /unsafe-inline/);
  });

  void it("reports 'unsafe-eval' in script-src", () => {
    assert.match(cspViolations(CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")).join("\n"), /unsafe-eval/);
  });

  void it("allows 'unsafe-inline' where it is not script-src", () => {
    assert.deepEqual(cspViolations(`${CSP}; style-src 'self' 'unsafe-inline'`), []);
  });

  void it("takes default-src for script-src when there is no script-src, and reports an unsafe one", () => {
    assert.deepEqual(cspViolations("default-src 'self'; frame-ancestors 'none'"), []);
    assert.match(cspViolations("default-src 'self' 'unsafe-inline'; frame-ancestors 'none'").join("\n"), /unsafe-inline/);
  });

  void it("reports a policy with neither script-src nor default-src", () => {
    assert.ok(cspViolations("frame-ancestors 'none'").length > 0);
  });

  void it("reports 'unsafe-inline' in script-src-elem and script-src-attr, which govern script elements and handlers beside script-src", () => {
    assert.match(cspViolations(`${CSP}; script-src-elem 'self' 'unsafe-inline'`).join("\n"), /script-src-elem.*unsafe-inline/);
    assert.match(cspViolations(`${CSP}; script-src-attr 'unsafe-inline'`).join("\n"), /script-src-attr.*unsafe-inline/);
    assert.match(cspViolations("script-src 'self'; script-src-elem 'unsafe-inline'; frame-ancestors 'none'").join("\n"), /script-src-elem/);
  });

  void it("accepts script-src-elem and script-src-attr that allow nothing unsafe", () => {
    assert.deepEqual(cspViolations(`${CSP}; script-src-elem 'self'; script-src-attr 'none'`), []);
  });

  void it("reports 'unsafe-eval', 'unsafe-hashes', 'wasm-unsafe-eval', data: and * in any directive that governs scripts", () => {
    for (const directive of ["script-src", "script-src-elem", "script-src-attr", "default-src"]) {
      for (const source of ["'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", "data:", "*", "'UNSAFE-INLINE'"]) {
        const policy = directive === "default-src" ? `default-src 'self' ${source}; frame-ancestors 'none'` : `${CSP}; ${directive} 'self' ${source}`;
        assert.ok(cspViolations(policy).length > 0, `${directive} ${source}`);
      }
    }
  });

  void it("takes default-src for a script directive that is absent, and a script directive over it", () => {
    assert.ok(cspViolations("default-src 'self' data:; script-src-elem 'self'; frame-ancestors 'none'").length > 0);
    assert.deepEqual(cspViolations("default-src 'self' data:; script-src 'self'; script-src-elem 'self'; script-src-attr 'none'; frame-ancestors 'none'"), []);
  });

  void it("allows data: and * where they do not govern scripts", () => {
    assert.deepEqual(cspViolations(`${CSP}; connect-src *; font-src data:`), []);
  });

  void it("reports a repeated directive, since the browser ignores the later one", () => {
    assert.match(cspViolations(`${CSP}; script-src 'unsafe-inline'`).join("\n"), /script-src.*more than once/);
    assert.match(cspViolations(`${CSP}; frame-ancestors *`).join("\n"), /frame-ancestors.*more than once/);
    assert.match(cspViolations(`${CSP}; SCRIPT-SRC 'self'`).join("\n"), /more than once/);
  });

  void it("reports a scheme-only source in a directive that governs scripts, since it allows every script of that scheme", () => {
    for (const source of ["https:", "http:", "blob:", "filesystem:", "ws:", "wss:", "HTTPS:", "custom+scheme.x:"]) {
      assert.ok(cspViolations("default-src 'self'; script-src 'self' " + source + "; frame-ancestors 'none'").length > 0, source);
      assert.ok(cspViolations("default-src 'self'; script-src-elem 'self' " + source + "; script-src 'self'; frame-ancestors 'none'").length > 0, source);
      assert.ok(cspViolations("default-src 'self'; script-src-attr " + source + "; script-src 'self'; frame-ancestors 'none'").length > 0, source);
    }
    assert.match(cspViolations("script-src 'self' https:; frame-ancestors 'none'").join("\n"), /script-src.*https:/);
    assert.match(cspViolations("script-src 'self' blob:; frame-ancestors 'none'").join("\n"), /blob:/);
  });

  void it("reports a host source with a wildcard in a directive that governs scripts", () => {
    for (const source of ["*", "*.example.test", "https://*", "https://*.example.test", "https://cdn.*.test", "*.example.test:443"]) {
      assert.ok(cspViolations("script-src 'self' " + source + "; frame-ancestors 'none'").length > 0, source);
      assert.ok(cspViolations("script-src 'self'; script-src-elem " + source + "; frame-ancestors 'none'").length > 0, source);
      assert.ok(cspViolations("script-src 'self'; worker-src " + source + "; frame-ancestors 'none'").length > 0, source);
    }
  });

  void it("judges worker-src, and child-src, script-src and default-src in turn where it is absent", () => {
    assert.match(cspViolations("script-src 'self'; worker-src *; frame-ancestors 'none'").join("\n"), /worker-src/);
    assert.match(cspViolations("script-src 'self'; worker-src blob:; frame-ancestors 'none'").join("\n"), /worker-src.*blob:/);
    assert.match(cspViolations("script-src 'self'; child-src *; frame-ancestors 'none'").join("\n"), /child-src/);
    assert.match(cspViolations("script-src 'self'; child-src blob:; frame-ancestors 'none'").join("\n"), /child-src.*blob:/);
    assert.deepEqual(cspViolations("script-src 'self'; child-src *; worker-src 'self'; frame-ancestors 'none'"), []);
    assert.deepEqual(cspViolations("script-src 'self'; child-src *; worker-src 'none'; frame-ancestors 'none'"), []);
    assert.deepEqual(cspViolations("default-src 'self' https:; script-src 'self'; frame-ancestors 'none'"), []);
    assert.match(cspViolations("default-src 'self' https:; frame-ancestors 'none'").join("\n"), /default-src.*https:/);
  });

  void it("accepts 'self', 'none', nonces, hashes, 'strict-dynamic' and explicit hosts in the script directives", () => {
    const allowed = [
      "script-src 'self'; frame-ancestors 'none'",
      "script-src 'none'; frame-ancestors 'none'",
      "script-src 'nonce-r4nd0m' 'strict-dynamic'; frame-ancestors 'none'",
      "script-src 'sha256-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG='; frame-ancestors 'none'",
      "script-src 'self' https://cdn.example.test https://static.example.test:8443/js/; frame-ancestors 'none'",
      "script-src 'self'; script-src-elem 'self' cdn.example.test; script-src-attr 'none'; worker-src 'self'; child-src 'self'; frame-ancestors 'none'",
    ];
    for (const policy of allowed) {
      assert.deepEqual(cspViolations(policy), [], policy);
    }
  });

  void it("allows a scheme and a wildcard in a directive that does not govern scripts or workers", () => {
    assert.deepEqual(cspViolations(`${CSP}; connect-src https: wss: *.example.test; font-src *; frame-src https://*; media-src blob:`), []);
  });

  void it("reports a missing frame-ancestors", () => {
    const violations = cspViolations(CSP.replace("; frame-ancestors 'none'", ""));
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /frame-ancestors/);
  });

  void it("reports a frame-ancestors that allows a page to frame the app", () => {
    assert.match(cspViolations(CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'")).join("\n"), /frame-ancestors/);
    assert.match(cspViolations(CSP.replace("frame-ancestors 'none'", "frame-ancestors *")).join("\n"), /frame-ancestors/);
  });

  void it("reads directive names without regard to case and ignores empty directives", () => {
    assert.deepEqual(cspViolations("DEFAULT-SRC 'self'; Script-Src 'self';; FRAME-ANCESTORS 'none';"), []);
  });

  void it("reports an absent and an empty policy", () => {
    assert.ok(cspViolations(undefined).length > 0);
    assert.ok(cspViolations("").length > 0);
  });

  void it("judges every policy of a header that holds several", () => {
    assert.deepEqual(cspViolations(`${CSP}, ${CSP}`), []);
    assert.ok(cspViolations(`${CSP}, ${CSP.replace("script-src 'self'", "script-src 'unsafe-inline'")}`).length > 0);
  });
});

void describe("the security headers (T5, T14)", () => {
  void it("accepts the headers the server sends", () => {
    assert.deepEqual(securityHeaderViolations(HEADERS), []);
  });

  void it("reads the names without regard to case", () => {
    const upper = Object.fromEntries(Object.entries(HEADERS).map(([name, value]) => [name.toUpperCase(), value]));
    assert.deepEqual(securityHeaderViolations(upper), []);
  });

  for (const name of Object.keys(HEADERS)) {
    void it(`reports a missing ${name}`, () => {
      const violations = securityHeaderViolations(without(HEADERS, name));
      assert.ok(violations.length > 0);
      assert.match(violations.join("\n"), name === "content-security-policy" ? /content-security-policy/i : new RegExp(name, "i"));
    });
  }

  void it("reports a policy that allows inline script and one that can be framed", () => {
    assert.ok(securityHeaderViolations({ ...HEADERS, "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; frame-ancestors 'none'" }).length > 0);
    assert.ok(securityHeaderViolations({ ...HEADERS, "content-security-policy": "default-src 'self'; script-src 'self'" }).length > 0);
  });

  void it("reports a Strict-Transport-Security with no or a zero max-age", () => {
    assert.ok(securityHeaderViolations({ ...HEADERS, "strict-transport-security": "includeSubDomains" }).length > 0);
    assert.ok(securityHeaderViolations({ ...HEADERS, "strict-transport-security": "max-age=0" }).length > 0);
  });

  void it("reports a Cross-Origin-Opener-Policy other than same-origin", () => {
    assert.ok(securityHeaderViolations({ ...HEADERS, "cross-origin-opener-policy": "unsafe-none" }).length > 0);
  });

  void it("reports a Referrer-Policy that sends the full address across sites, and an empty one", () => {
    assert.ok(securityHeaderViolations({ ...HEADERS, "referrer-policy": "unsafe-url" }).length > 0);
    assert.ok(securityHeaderViolations({ ...HEADERS, "referrer-policy": "no-referrer-when-downgrade" }).length > 0);
    assert.ok(securityHeaderViolations({ ...HEADERS, "referrer-policy": "" }).length > 0);
  });

  void it("accepts the other policies that keep the path across sites private", () => {
    for (const policy of ["no-referrer", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin"]) {
      assert.deepEqual(securityHeaderViolations({ ...HEADERS, "referrer-policy": policy }), [], policy);
    }
  });

  void it("reports X-Content-Type-Options other than nosniff", () => {
    assert.ok(securityHeaderViolations({ ...HEADERS, "x-content-type-options": "sniff" }).length > 0);
  });
});

void describe("the cache and referrer headers of /api and /go", () => {
  void it("accepts no-store", () => {
    assert.deepEqual(noStoreViolations({ "cache-control": "no-store" }), []);
  });

  void it("reports a missing Cache-Control and one that lets a cache keep the answer", () => {
    assert.ok(noStoreViolations({}).length > 0);
    assert.ok(noStoreViolations({ "cache-control": "public, max-age=60" }).length > 0);
    assert.ok(noStoreViolations({ "cache-control": "no-cache" }).length > 0);
    assert.ok(noStoreViolations({ "cache-control": "private" }).length > 0);
  });

  void it("accepts no-store among other directives", () => {
    assert.deepEqual(noStoreViolations({ "cache-control": "private, No-Store" }), []);
  });

  void it("accepts a /go answer with no-store and no-referrer", () => {
    assert.deepEqual(goHeaderViolations({ "cache-control": "no-store", "referrer-policy": "no-referrer" }), []);
  });

  void it("reports a /go answer without no-referrer and one without no-store", () => {
    assert.match(goHeaderViolations({ "cache-control": "no-store", "referrer-policy": "strict-origin-when-cross-origin" }).join("\n"), /no-referrer/);
    assert.match(goHeaderViolations({ "cache-control": "no-store" }).join("\n"), /no-referrer/);
    assert.match(goHeaderViolations({ "referrer-policy": "no-referrer" }).join("\n"), /no-store/);
  });
});

void describe("the cross-site rules (T5)", () => {
  const refusal = { type: "about:blank", title: "Forbidden", status: 403, code: "cross_site_request", detail: "This request must come from the application itself.", requestId: "r" };

  void it("accepts 403 cross_site_request", () => {
    assert.deepEqual(crossSiteRefusalViolations("a foreign Origin", answer(403, refusal)), []);
  });

  void it("reports a 2xx answer to the cross-origin mutation, as when the Origin check is removed", () => {
    for (const status of [200, 201, 204]) {
      const violations = crossSiteRefusalViolations("a foreign Origin", answer(status, { id: "x" }));
      assert.equal(violations.length, 1);
      assert.match(violations[0] ?? "", /a foreign Origin/);
      assert.match(violations[0] ?? "", /processed/);
    }
  });

  void it("reports a refusal under another status or another code", () => {
    assert.ok(crossSiteRefusalViolations("no Origin", answer(401, { ...refusal, status: 401, code: "unauthenticated" })).length > 0);
    assert.ok(crossSiteRefusalViolations("no Origin", answer(403, { ...refusal, code: "forbidden" })).length > 0);
    assert.ok(crossSiteRefusalViolations("no Origin", answer(400, refusal)).length > 0);
    assert.ok(crossSiteRefusalViolations("no Origin", answer(429, refusal)).length > 0);
    assert.ok(crossSiteRefusalViolations("no Origin", answer(500, refusal)).length > 0);
  });

  void it("reports a body it cannot classify", () => {
    for (const body of [undefined, null, "text", 3, [], {}, { code: 3 }]) {
      assert.ok(crossSiteRefusalViolations("no Origin", answer(403, body)).length > 0, JSON.stringify(body));
    }
  });

  void it("accepts the status the request is meant to get and reports another", () => {
    assert.deepEqual(processedViolations("a bearer token", answer(201, {}), 201), []);
    assert.ok(processedViolations("a bearer token", answer(403, refusal), 201).length > 0);
    assert.ok(processedViolations("a bearer token", answer(401, {}), 201).length > 0);
  });

  void it("accepts 401 for a token that is not valid and reports any other answer, a processed one included", () => {
    const unauthenticated = { code: "unauthenticated", status: 401 };
    assert.deepEqual(unauthenticatedViolations("a bearer token that is not valid", answer(401, unauthenticated)), []);
    assert.ok(unauthenticatedViolations("a bearer token that is not valid", answer(201, {})).length > 0);
    assert.ok(unauthenticatedViolations("a bearer token that is not valid", answer(403, refusal)).length > 0);
    assert.ok(unauthenticatedViolations("a bearer token that is not valid", answer(401, {})).length > 0);
  });

  void it("reports a refused request whose write is there", () => {
    assert.deepEqual(leakedBookmarks(["https://refused.test/a", "https://refused.test/b"], ["https://allowed.test/"]), []);
    const violations = leakedBookmarks(["https://refused.test/a", "https://refused.test/b"], ["https://allowed.test/", "https://refused.test/b"]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /refused\.test\/b/);
  });
});

void describe("the probes (T22)", () => {
  void it("accepts the body of /health", () => {
    assert.deepEqual(healthViolations(answer(200, { status: "ok" })), []);
  });

  void it("reports a /health body with an extra key", () => {
    const violations = healthViolations(answer(200, { status: "ok", version: "1.0.0" }));
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /version/);
  });

  void it("reports a /health body that is not exactly the status ok, and one that is not a status 200", () => {
    for (const body of [{}, { status: "degraded" }, { status: "ok " }, { status: 1 }, { state: "ok" }, null, "ok", [], undefined]) {
      assert.ok(healthViolations(answer(200, body)).length > 0, JSON.stringify(body));
    }
    assert.ok(healthViolations(answer(503, { status: "ok" })).length > 0);
  });

  void it("accepts the body of /version", () => {
    assert.deepEqual(versionViolations(answer(200, { name: "SlugBase", version: "1.0.0", commit: "abc", builtAt: "2026-01-01T00:00:00Z" })), []);
  });

  void it("reports a /version body with a fifth key, a missing key and a member that is not a non-empty string", () => {
    const body = { name: "SlugBase", version: "1.0.0", commit: "abc", builtAt: "2026-01-01T00:00:00Z" };
    assert.match(versionViolations(answer(200, { ...body, node: "24.0.0" })).join("\n"), /node/);
    assert.ok(versionViolations(answer(200, { name: "SlugBase", version: "1.0.0", commit: "abc" })).length > 0);
    assert.ok(versionViolations(answer(200, { ...body, commit: "" })).length > 0);
    assert.ok(versionViolations(answer(200, { ...body, commit: 3 })).length > 0);
    assert.ok(versionViolations(answer(200, null)).length > 0);
    assert.ok(versionViolations(answer(500, body)).length > 0);
  });

  void it("reports a probe that sets a cookie, without naming it", () => {
    const violations = healthViolations(answer(200, { status: "ok" }, ["__Host-slugbase_session=top-secret-value; Path=/"]));
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /Set-Cookie/);
    assert.ok(!violations[0]?.includes("top-secret-value"));
    assert.ok(versionViolations(answer(200, { name: "a", version: "b", commit: "c", builtAt: "d" }, ["a=b"])).length > 0);
  });
});

void describe("the closed setup endpoint (doc 10 section 2.1)", () => {
  const closed = { code: "setup_completed", status: 403 };

  void it("accepts 403 setup_completed that sets no cookie", () => {
    assert.deepEqual(setupClosedViolations(answer(403, closed)), []);
  });

  void it("reports an account created (201), another refusal and an answer it cannot classify", () => {
    assert.ok(setupClosedViolations(answer(201, { workspaceId: "w" }, [SESSION_COOKIE])).length > 0);
    assert.ok(setupClosedViolations(answer(403, { code: "forbidden", status: 403 })).length > 0);
    assert.ok(setupClosedViolations(answer(422, { code: "validation_failed" })).length > 0);
    assert.ok(setupClosedViolations(answer(403, null)).length > 0);
    assert.ok(setupClosedViolations(answer(403, "setup_completed")).length > 0);
  });

  void it("reports a refusal that signs somebody in", () => {
    assert.match(setupClosedViolations(answer(403, closed, [SESSION_COOKIE])).join("\n"), /Set-Cookie/);
  });

  void it("reports the account of the refused setup, however its address is cased", () => {
    const email = "setup-ab12@example.test";
    assert.deepEqual(leakedAccounts([{ email: "owner@example.test" }], email), []);
    assert.deepEqual(leakedAccounts([], email), []);
    assert.equal(leakedAccounts([{ email: "owner@example.test" }, { email }], email).length, 1);
    assert.equal(leakedAccounts([{ email: "SETUP-AB12@Example.test" }], email).length, 1);
  });

  void it("does not report other accounts that appear while the journey runs", () => {
    assert.deepEqual(leakedAccounts([{ email: "owner@example.test" }, { email: "late-comer@example.test" }, { email: "setup-ab123@example.test" }], "setup-ab12@example.test"), []);
  });

  void it("reports a list that could not be read", () => {
    assert.ok(leakedAccounts(undefined, "setup-ab12@example.test").length > 0);
  });
});
