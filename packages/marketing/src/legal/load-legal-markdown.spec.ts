import { describe, expect, it } from "vitest";
import {
  extractLocaleMarkdown,
  loadLegalMarkdown,
  renderLegalHtml,
} from "./load-legal-markdown.js";

describe("loadLegalMarkdown", () => {
  it("loads impressum EN from draft with hello@slugbase.app and no WKO", () => {
    const markdown = loadLegalMarkdown("impressum", "en");
    expect(markdown).toContain("hello@slugbase.app");
    expect(markdown).not.toMatch(/\bWKO\b/i);
    expect(markdown).toContain("Michael David Guggenbichler");
  });

  it("loads impressum DE from draft", () => {
    const markdown = loadLegalMarkdown("impressum", "de");
    expect(markdown).toContain("hello@slugbase.app");
    expect(markdown).toContain("Diensteanbieter");
  });

  it("loads datenschutz EN with subprocessor and Sentry split content", () => {
    const markdown = loadLegalMarkdown("datenschutz", "en");
    expect(markdown).toContain("Fly.io");
    expect(markdown).toContain("Neon Postgres");
    expect(markdown).toContain("Cloudflare");
    expect(markdown).toContain("3.8 Error Reporting — Server-Side");
    expect(markdown).toContain("3.8a Error Reporting — Client-Side");
    expect(markdown).toContain("JSON export");
  });

  it("loads agb EN from draft", () => {
    const markdown = loadLegalMarkdown("agb", "en");
    expect(markdown).toContain("Terms of Service");
    expect(markdown).toContain("hello@slugbase.app");
  });

  it("renders markdown to HTML with tables", () => {
    const html = renderLegalHtml("datenschutz", "en");
    expect(html).toContain("<table>");
    expect(html).toContain("Fly.io");
  });

  it("extractLocaleMarkdown splits bilingual drafts", () => {
    const draft = `## English\n\nHello EN\n\n---\n\n## Deutsch\n\nHallo DE`;
    expect(extractLocaleMarkdown(draft, "en")).toBe("Hello EN");
    expect(extractLocaleMarkdown(draft, "de")).toBe("Hallo DE");
  });
});
