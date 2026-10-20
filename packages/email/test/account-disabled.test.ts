import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The "account disabled" email (doc 02 sections 11.2 and 12): rendered in the recipient's language with a plain-text
// part, no tracking element and no link, since nothing in the application is open to the reader while the account is
// disabled.

const templates = createMailTemplates({ appOrigin: "https://bookmarks.example.com" });

async function render(locale: string, data: Record<string, string> = { displayName: "Ada Lovelace" }) {
  const mail = new InMemoryMail();
  await mail.send({ template: "accountDisabled", to: "ada@example.test", locale, data });
  const message = mail.sent[0];
  const template = message === undefined ? undefined : templates[message.template];
  if (message === undefined || template === undefined) {
    throw new Error("the message was not captured or has no template");
  }
  return template({ data: message.data, locale: message.locale });
}

describe("the account disabled template", () => {
  it("renders English for an English recipient, addressed by name, and says the account cannot sign in", async () => {
    const rendered = await render("en");
    expect(rendered.subject).toBe("Your SlugBase account was disabled");
    expect(rendered.text).toContain("Hi Ada Lovelace,");
    expect(rendered.text).toContain("You can no longer sign in");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("renders German for a German recipient", async () => {
    const rendered = await render("de");
    expect(rendered.subject).toBe("Dein SlugBase-Konto wurde deaktiviert");
    expect(rendered.text).toContain("Hallo Ada Lovelace,");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it("falls back to English for a language it has no catalog for, and greets without a name when the account has none", async () => {
    expect((await render("fr")).subject).toBe("Your SlugBase account was disabled");
    expect((await render("en", { displayName: "  " })).text.startsWith("Hi,\n")).toBe(true);
    expect((await render("en", {})).text.startsWith("Hi,\n")).toBe(true);
  });

  it.each(["en", "de"])("links nowhere and holds no tracking element (%s)", async (locale) => {
    const rendered = await render(locale);
    expect(rendered.text).not.toMatch(/https?:\/\//);
    expect(rendered.html).not.toMatch(/https?:\/\//);
    expect(rendered.html).not.toMatch(/<(img|script|iframe|link|object|embed|a)\b/i);
  });

  it("escapes the display name in the HTML part and keeps the subject on one line", async () => {
    const rendered = await render("en", { displayName: '<img src="https://tracker.example/p.gif">\r\nBcc: x@example.test' });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });
});
