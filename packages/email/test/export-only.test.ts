import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The "export-only" email (doc 02 sections 2.11 and 12): rendered in the recipient's language with a plain-text part, the end date in UTC and the
// link to the export page on the deployment's own origin, and nothing else. The failure scenarios are a message without an end date, a link that
// follows a host in the data, and a name that reaches the subject or the markup unescaped.

const ORIGIN = "https://bookmarks.example.com";
const templates = createMailTemplates({ appOrigin: ORIGIN });
const UNTIL = "2026-12-01T10:30:00.000Z";

async function render(locale: string, data: Record<string, string> = { displayName: "Ada Lovelace", until: UNTIL }) {
  const mail = new InMemoryMail();
  await mail.send({ template: "exportOnly", to: "ada@example.test", locale, data });
  const message = mail.sent[0];
  const template = message === undefined ? undefined : templates[message.template];
  if (message === undefined || template === undefined) {
    throw new Error("the message was not captured or has no template");
  }
  return template({ data: message.data, locale: message.locale });
}

describe("the export-only template", () => {
  it("renders English with the end date in UTC, addressed by name, and says what the account can still do", async () => {
    const rendered = await render("en");
    expect(rendered.subject).toBe("Your SlugBase account can only export its data from now on");
    expect(rendered.text).toContain("Hi Ada Lovelace,");
    expect(rendered.text).toContain("Until December 1, 2026 at 10:30 AM UTC you can still sign in, read your bookmarks and export them.");
    expect(rendered.text).toContain("You cannot change anything");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("renders German for a German recipient, with the date written the German way", async () => {
    const rendered = await render("de");
    expect(rendered.subject).toBe("Dein SlugBase-Konto kann ab jetzt nur noch Daten exportieren");
    expect(rendered.text).toContain("Hallo Ada Lovelace,");
    expect(rendered.text).toContain("1. Dezember 2026");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it("falls back to English for a language it has no catalog for, and greets without a name when the account has none", async () => {
    expect((await render("fr")).subject).toBe("Your SlugBase account can only export its data from now on");
    expect((await render("en", { displayName: "  ", until: UNTIL })).text.startsWith("Hi,\n")).toBe(true);
    expect((await render("en", { until: UNTIL })).text.startsWith("Hi,\n")).toBe(true);
  });

  it.each(["en", "de"])("links to the export page of the configured origin and to nothing else, with no tracking element (%s)", async (locale) => {
    const rendered = await render(locale, { displayName: "x", until: UNTIL, link: "https://evil.example/", appOrigin: "https://evil.example" });
    expect(rendered.text).toContain(`${ORIGIN}/settings/account/data`);
    const links = [...rendered.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(links).toEqual([`${ORIGIN}/settings/account/data`]);
    expect(rendered.html).not.toMatch(/<(img|script|iframe|link|object|embed)\b/i);
    expect(rendered.text + rendered.html).not.toContain("evil.example");
  });

  it("refuses a message without an end date, or with one that is not a date, instead of sending one that names nothing", async () => {
    await expect(render("en", { displayName: "Ada" })).rejects.toThrow(RangeError);
    await expect(render("en", { displayName: "Ada", until: "soon" })).rejects.toThrow(RangeError);
  });

  it("escapes the display name in the HTML part and keeps the subject on one line", async () => {
    const rendered = await render("en", { displayName: '<img src="https://tracker.example/p.gif">\r\nBcc: x@example.test', until: UNTIL });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.text.split("\n")[0]).not.toMatch(/[\r]/);
  });
});
