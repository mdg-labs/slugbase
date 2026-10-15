import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The "MFA enabled" and "MFA disabled" emails (doc 02 section 12): rendered in the
// recipient's language with a plain-text part, no tracking element, a link only to
// the deployment's origin, and nothing of the second factor itself. The message
// reaches a mail port as the worker hands it over; the template renders it as the
// SMTP adapter does.

const ORIGIN = "https://bookmarks.example.com";
const LINK = `${ORIGIN}/settings/account/security`;
const templates = createMailTemplates({ appOrigin: ORIGIN });

const SUBJECTS = {
  mfaEnabled: { en: "Two-factor authentication was turned on for your SlugBase account", de: "Die Zwei-Faktor-Authentifizierung wurde für dein SlugBase-Konto eingeschaltet" },
  mfaDisabled: { en: "Two-factor authentication was turned off for your SlugBase account", de: "Die Zwei-Faktor-Authentifizierung wurde für dein SlugBase-Konto ausgeschaltet" },
} as const;
const NAMES = ["mfaEnabled", "mfaDisabled"] as const;

async function render(template: (typeof NAMES)[number], locale: string, data: Record<string, string> = { displayName: "Ada Lovelace" }) {
  const mail = new InMemoryMail();
  await mail.send({ template, to: "ada@example.test", locale, data });
  const message = mail.sent[0];
  const compose = message === undefined ? undefined : templates[message.template];
  if (message === undefined || compose === undefined) {
    throw new Error("the message was not captured or has no template");
  }
  return { message, rendered: compose({ data: message.data, locale: message.locale }) };
}

function linksOf(content: string): string[] {
  return [...content.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
}

describe.each(NAMES)("the %s template", (name) => {
  it("renders English for an English recipient, addressed by name, and German for a German one", async () => {
    const english = await render(name, "en");
    expect(english.message.to).toBe("ada@example.test");
    expect(english.message.locale).toBe("en");
    expect(english.rendered.subject).toBe(SUBJECTS[name].en);
    expect(english.rendered.text).toContain("Hi Ada Lovelace,");
    expect(english.rendered.html).toContain('<html lang="en">');

    const german = await render(name, "de");
    expect(german.message.locale).toBe("de");
    expect(german.rendered.subject).toBe(SUBJECTS[name].de);
    expect(german.rendered.text).toContain("Hallo Ada Lovelace,");
    expect(german.rendered.html).toContain('<html lang="de">');
  });

  it("falls back to English for a language it has no catalog for", async () => {
    const { rendered } = await render(name, "fr");
    expect(rendered.subject).toBe(SUBJECTS[name].en);
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("greets without a name when the account has none", async () => {
    expect((await render(name, "en", { displayName: "  " })).rendered.text.startsWith("Hi,\n")).toBe(true);
    expect((await render(name, "en", {})).rendered.text.startsWith("Hi,\n")).toBe(true);
  });

  it.each(["en", "de"])("has a text part and an HTML part that link only to the security settings of the origin (%s)", async (locale) => {
    const { rendered } = await render(name, locale);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.text).not.toContain("<");
    expect(linksOf(rendered.text)).toEqual([LINK]);
    expect(linksOf(rendered.html)).toEqual([LINK]);
    expect(rendered.html.match(/\bhref="[^"]*"/g)).toEqual([`href="${LINK}"`]);
    expect(rendered.html).not.toMatch(/<(img|script|iframe|link|object|embed|video|audio|source|style)\b/i);
    expect(rendered.html).not.toMatch(/\bsrc=/i);
  });

  it("takes neither a secret, a code nor a link from the data of the message", async () => {
    const hostile = { displayName: "x", link: "https://evil.example/", appOrigin: "https://evil.example", secret: "JBSWY3DPEHPK3PXP", code: "123456", backupCodes: "ABCD-EFGH" };
    const { rendered } = await render(name, "en", hostile);
    const everything = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
    expect(linksOf(rendered.html).every((link) => link.startsWith(`${ORIGIN}/`))).toBe(true);
    for (const value of ["evil.example", "JBSWY3DPEHPK3PXP", "123456", "ABCD-EFGH"]) {
      expect(everything).not.toContain(value);
    }
  });

  it("escapes the display name in the HTML part and keeps the subject free of line breaks", async () => {
    const { rendered } = await render(name, "en", { displayName: '<img src="https://tracker.example/p.gif">\r\nBcc: someone@example.test' });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });
});

describe("the two messages", () => {
  it("say which way the second factor changed", async () => {
    const enabled = (await render("mfaEnabled", "en")).rendered.text;
    const disabled = (await render("mfaDisabled", "en")).rendered.text;
    expect(enabled).toContain("turned on");
    expect(enabled).not.toContain("turned off");
    expect(disabled).toContain("turned off");
    expect(disabled).not.toContain("turned on");
  });
});
