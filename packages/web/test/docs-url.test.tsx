import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { buildDocsUrl, DOCS_ROUTES, normalizeDocsBaseUrl, useDocsUrl, type DocsRoute } from "../src/docs/docs-url.ts";
import { CONFIG_BODY } from "./support.tsx";

describe("buildDocsUrl", () => {
  it("joins the base URL and a route with one slash", () => {
    expect(buildDocsUrl("https://slugbase.app/docs", DOCS_ROUTES.gettingStarted)).toBe("https://slugbase.app/docs/getting-started");
    expect(buildDocsUrl("https://slugbase.app/docs/", DOCS_ROUTES.gettingStarted)).toBe("https://slugbase.app/docs/getting-started");
    expect(buildDocsUrl("https://docs.example.org///", DOCS_ROUTES.selfHosting)).toBe("https://docs.example.org/self-hosting");
  });

  it("is the base URL without a trailing slash when no route, or the landing route, is given", () => {
    expect(buildDocsUrl("https://docs.example.org/docs/")).toBe("https://docs.example.org/docs");
    expect(buildDocsUrl("https://docs.example.org/docs", DOCS_ROUTES.home)).toBe("https://docs.example.org/docs");
    expect(buildDocsUrl("https://docs.example.org")).toBe("https://docs.example.org");
  });

  it("carries no query string, fragment or credentials of the configured base URL", () => {
    expect(buildDocsUrl("https://user:secret@docs.example.org/docs/?instance=abc#top", DOCS_ROUTES.selfHosting)).toBe(
      "https://docs.example.org/docs/self-hosting",
    );
  });

  it("only accepts a route of the registry", () => {
    expectTypeOf<DocsRoute>().toEqualTypeOf<"" | "getting-started" | "self-hosting">();
    expectTypeOf<"pricing">().not.toExtend<DocsRoute>();
    expectTypeOf(buildDocsUrl).parameter(1).toEqualTypeOf<DocsRoute | undefined>();
  });
});

describe("normalizeDocsBaseUrl", () => {
  it.each(["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "ftp://docs.example.org", "//docs.example.org", "docs", "", "https:"])(
    "falls back to the default site for %j",
    (value) => {
      expect(normalizeDocsBaseUrl(value)).toBe("https://slugbase.app/docs");
    },
  );

  it("keeps an http or https URL", () => {
    expect(normalizeDocsBaseUrl("http://localhost:4000/help/")).toBe("http://localhost:4000/help");
    expect(normalizeDocsBaseUrl("HTTPS://Docs.Example.org/docs")).toBe("https://docs.example.org/docs");
  });
});

describe("useDocsUrl", () => {
  function docsUrlFor(docsBaseUrl: string): (route?: DocsRoute) => string {
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <ConfigProvider config={{ ...CONFIG_BODY, features: { ...CONFIG_BODY.features }, locales: [...CONFIG_BODY.locales], product: { ...CONFIG_BODY.product }, docsBaseUrl }}>
        {children}
      </ConfigProvider>
    );
    return renderHook(() => useDocsUrl(), { wrapper }).result.current;
  }

  it("builds addresses over the docsBaseUrl of /api/config", () => {
    const docsUrl = docsUrlFor("https://docs.example.org/help/");
    expect(docsUrl()).toBe("https://docs.example.org/help");
    expect(docsUrl(DOCS_ROUTES.gettingStarted)).toBe("https://docs.example.org/help/getting-started");
  });

  it("never yields a script address from a hostile configuration", () => {
    expect(docsUrlFor("javascript:alert(1)")(DOCS_ROUTES.selfHosting)).toBe("https://slugbase.app/docs/self-hosting");
  });
});
