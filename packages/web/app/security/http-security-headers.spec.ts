import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyDocumentSecurityHeaders,
  applyStaticSecurityHeaders,
  buildDocumentContentSecurityPolicy,
  buildStaticContentSecurityPolicy,
  mergeWorkerSecurityHeaders,
} from "./http-security-headers.js";

describe("buildDocumentContentSecurityPolicy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env["API_BASE_URL"];
  });

  it("includes nonce and strict-dynamic for inline React Router scripts", () => {
    const policy = buildDocumentContentSecurityPolicy({
      cspNonce: "abc123",
    });
    expect(policy).toContain("'nonce-abc123'");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("allowlists Umami when VITE_UMAMI_HOST is configured", () => {
    vi.stubEnv("VITE_UMAMI_HOST", "https://analytics.example.com");
    const policy = buildDocumentContentSecurityPolicy({ cspNonce: "n1" });
    expect(policy).toContain("https://analytics.example.com");
  });

  it("allowlists API origin in connect-src", () => {
    process.env["API_BASE_URL"] = "https://api.slugbase.test";
    const policy = buildDocumentContentSecurityPolicy({ cspNonce: "n1" });
    expect(policy).toContain("connect-src");
    expect(policy).toContain("https://api.slugbase.test");
  });

  it("allows websocket sources in development", () => {
    const policy = buildDocumentContentSecurityPolicy({
      cspNonce: "n1",
      isDev: true,
    });
    expect(policy).toContain("ws:");
    expect(policy).toContain("'unsafe-eval'");
  });
});

describe("buildStaticContentSecurityPolicy", () => {
  it("restricts scripts to self without nonce", () => {
    const policy = buildStaticContentSecurityPolicy();
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("nonce-");
    expect(policy).toContain("frame-ancestors 'none'");
  });
});

describe("applyDocumentSecurityHeaders", () => {
  it("sets CSP and clickjacking headers on document responses", () => {
    const headers = new Headers();
    applyDocumentSecurityHeaders(headers, {
      cspNonce: "test-nonce",
      isHttps: true,
    });

    expect(headers.get("Content-Security-Policy")).toContain("'nonce-test-nonce'");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Strict-Transport-Security")).toContain("max-age=");
  });
});

describe("applyStaticSecurityHeaders", () => {
  it("sets static CSP without overriding existing values", () => {
    const headers = new Headers({
      "X-Frame-Options": "SAMEORIGIN",
    });
    applyStaticSecurityHeaders(headers, { isHttps: false });

    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });
});

describe("mergeWorkerSecurityHeaders", () => {
  it("preserves SSR document CSP while adding baseline headers", () => {
    const response = new Response("<html></html>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; script-src 'nonce-abc'",
      },
    });
    const request = new Request("https://app.slugbase.test/");
    const merged = mergeWorkerSecurityHeaders(response, request, false);

    expect(merged.headers.get("Content-Security-Policy")).toContain("nonce-abc");
    expect(merged.headers.get("X-Frame-Options")).toBe("DENY");
    expect(merged.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("applies static CSP to asset responses", () => {
    const response = new Response("console.log(1)", {
      headers: { "Content-Type": "application/javascript" },
    });
    const request = new Request("https://app.slugbase.test/assets/main.js");
    const merged = mergeWorkerSecurityHeaders(response, request, false);

    expect(merged.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(merged.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
