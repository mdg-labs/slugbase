import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The "password changed" email (doc 02 section 12): rendered in the recipient's
// language with a plain-text part, no tracking element and links only to the
// deployment's origin. The message reaches a mail port as the worker hands it
// over; the template renders it as the SMTP adapter does.

const ORIGIN = "https://bookmarks.example.com";
const templates = createMailTemplates({ appOrigin: ORIGIN });

async function render(locale: string, data: Record<string, string> = { displayName: "Ada Lovelace" }) {
  const mail = new InMemoryMail();
  await mail.send({ template: "passwordChanged", to: "ada@example.test", locale, data });
  const message = mail.sent[0];
  const template = message === undefined ? undefined : templates[message.template];
  if (message === undefined || template === undefined) {
    throw new Error("the message was not captured or has no template");
  }
  return { message, rendered: template({ data: message.data, locale: message.locale }) };
}

function linksOf(content: string): string[] {
  return [...content.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
}

describe("the password changed template", () => {
  it("renders English for an English recipient, addressed by name", async () => {
    const { message, rendered } = await render("en");
    expect(message.to).toBe("ada@example.test");
    expect(message.locale).toBe("en");
    expect(rendered.subject).toBe("Your SlugBase password was changed");
    expect(rendered.text).toContain("Hi Ada Lovelace,");
    expect(rendered.html).toContain('<html lang="en">');
    expect(rendered.html).toContain("Hi Ada Lovelace,");
  });

  it("renders German for a German recipient", async () => {
    const { message, rendered } = await render("de");
    expect(message.locale).toBe("de");
    expect(rendered.subject).toBe("Dein SlugBase-Passwort wurde geändert");
    expect(rendered.text).toContain("Hallo Ada Lovelace,");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it("falls back to English for a language it has no catalog for", async () => {
    const { rendered } = await render("fr");
    expect(rendered.subject).toBe("Your SlugBase password was changed");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("greets without a name when the account has none", async () => {
    const { rendered } = await render("en", { displayName: "  " });
    expect(rendered.text.startsWith("Hi,\n")).toBe(true);
    const missing = await render("en", {});
    expect(missing.rendered.text.startsWith("Hi,\n")).toBe(true);
  });

  it.each(["en", "de"])("has a text part with the same link as the HTML part (%s)", async (locale) => {
    const { rendered } = await render(locale);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.text).not.toContain("<");
    expect(linksOf(rendered.text)).toEqual([`${ORIGIN}/settings/account/security`]);
    expect(linksOf(rendered.html)).toEqual([`${ORIGIN}/settings/account/security`]);
  });

  it.each(["en", "de"])("holds no tracking element, remote asset or script (%s)", async (locale) => {
    const { rendered } = await render(locale);
    expect(rendered.html).not.toMatch(/<(img|script|iframe|link|object|embed|video|audio|source|style)\b/i);
    expect(rendered.html).not.toMatch(/\burl\(/i);
    expect(rendered.html).not.toMatch(/\bsrc=/i);
    expect(rendered.html.match(/\bhref="[^"]*"/g)).toEqual([`href="${ORIGIN}/settings/account/security"`]);
    expect(rendered.html).not.toMatch(/[?&](utm_|track)/i);
  });

  it("escapes the display name in the HTML part", async () => {
    const { rendered } = await render("en", { displayName: '<img src="https://tracker.example/p.gif">' });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain("tracker.example/p.gif\">");
    expect(rendered.html).toContain("&lt;img");
  });

  it("keeps a subject free of line breaks whatever the name holds", async () => {
    const { rendered } = await render("en", { displayName: "Ada\r\nBcc: someone@example.test" });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it("points links to the origin of the configuration, not to a host in the data", async () => {
    const { rendered } = await render("en", { displayName: "x", link: "https://evil.example/", appOrigin: "https://evil.example" });
    expect(linksOf(rendered.html).every((link) => link.startsWith(`${ORIGIN}/`))).toBe(true);
    const other = createMailTemplates({ appOrigin: "http://localhost:5173/" }).passwordChanged;
    expect(other?.({ data: { displayName: "x" }, locale: "en" }).text).toContain("http://localhost:5173/settings/account/security");
  });
});

describe("createMailTemplates", () => {
  it("names the template the core sends", () => {
    expect(Object.keys(templates)).toEqual(["passwordChanged", "mfaEnabled", "mfaDisabled", "verifyEmail", "newSignIn", "passwordReset", "emailChange", "emailChangeNotice", "ownershipTransferred", "invitation", "testMail", "accountDisabled"]);
  });

  it("refuses an origin that is not http or https", () => {
    expect(() => createMailTemplates({ appOrigin: "ftp://bookmarks.example.com" })).toThrow(RangeError);
    expect(() => createMailTemplates({ appOrigin: "not a url" })).toThrow();
  });
});
