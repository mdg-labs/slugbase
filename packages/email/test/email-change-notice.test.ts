import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The email-change notice (doc 02 section 2.6), mailed to the old address: rendered in the recipient's language with a
// plain-text part, no tracking element, and one link, to the deployment's own origin, whose token is
// in the fragment so it reaches no server log and no Referer header.

const ORIGIN = "https://bookmarks.example.com";
const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const LINK = `${ORIGIN}/email-change/cancel#token=${TOKEN}`;
const templates = createMailTemplates({ appOrigin: ORIGIN });

async function render(locale: string, data: Record<string, string> = { displayName: "Ada Lovelace", token: TOKEN }) {
  const mail = new InMemoryMail();
  await mail.send({ template: "emailChangeNotice", to: "ada@example.test", locale, data });
  const message = mail.sent[0];
  const template = message === undefined ? undefined : templates[message.template];
  if (message === undefined || template === undefined) {
    throw new Error("the message was not captured or has no template");
  }
  return template({ data: message.data, locale: message.locale });
}

function linksOf(content: string): string[] {
  return [...content.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
}

describe("the email-change notice template", () => {
  it("renders English for an English recipient, addressed by name", async () => {
    const rendered = await render("en");
    expect(rendered.subject).toBe("A new email address was requested for your SlugBase account");
    expect(rendered.text).toContain("Hi Ada Lovelace,");
    expect(rendered.text).toContain("1 hour");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("renders German for a German recipient", async () => {
    const rendered = await render("de");
    expect(rendered.subject).toBe("Für dein SlugBase-Konto wurde eine neue E-Mail-Adresse angefordert");
    expect(rendered.text).toContain("Hallo Ada Lovelace,");
    expect(rendered.text).toContain("1 Stunde");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it.each([
    ["en", "This wasn't me", "signs out every device", "takes effect only once the new address has been confirmed"],
    ["de", "Das war ich nicht", "meldet alle Geräte ab", "gilt erst, wenn die neue Adresse bestätigt wurde"],
  ])("offers the link as the \"this wasn't me\" action and says it cancels the change and ends every session (%s)", async (locale, action, signOut, pending) => {
    const rendered = await render(locale);
    expect(rendered.text).toContain(`${action}: ${LINK}`);
    expect(rendered.html).toContain(`>${action.replaceAll("'", "&#39;")}</a>`);
    expect(rendered.text).toContain(signOut);
    expect(rendered.text).toContain(pending);
  });

  it("falls back to English for a language it has no catalog for", async () => {
    const rendered = await render("fr");
    expect(rendered.subject).toBe("A new email address was requested for your SlugBase account");
  });

  it("greets without a name when the account has none", async () => {
    expect((await render("en", { displayName: "  ", token: TOKEN })).text.startsWith("Hi,\n")).toBe(true);
    expect((await render("en", { token: TOKEN })).text.startsWith("Hi,\n")).toBe(true);
  });

  it.each(["en", "de"])("links once to /email-change/cancel with the token in the fragment, in both parts (%s)", async (locale) => {
    const rendered = await render(locale);
    expect(linksOf(rendered.text)).toEqual([LINK]);
    expect(linksOf(rendered.html)).toEqual([LINK]);
    expect(rendered.html.match(/\bhref="[^"]*"/g)).toEqual([`href="${LINK}"`]);
    expect(new URL(LINK).search).toBe("");
    expect(rendered.text).not.toContain("<");
  });

  it.each(["en", "de"])("holds no tracking element, remote asset or script (%s)", async (locale) => {
    const { html } = await render(locale);
    expect(html).not.toMatch(/<(img|script|iframe|link|object|embed|video|audio|source|style)\b/i);
    expect(html).not.toMatch(/\burl\(/i);
    expect(html).not.toMatch(/\bsrc=/i);
  });

  it("escapes the display name in the HTML part", async () => {
    const { html } = await render("en", { displayName: '<img src="https://tracker.example/p.gif">', token: TOKEN });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it.each([
    ["a missing token", { displayName: "Ada" }],
    ["a token of the wrong length", { displayName: "Ada", token: "short" }],
    ["a token with a character a link cannot carry", { displayName: "Ada", token: `${TOKEN.slice(0, 42)}"` }],
    ["a token that would end the fragment", { displayName: "Ada", token: `${TOKEN.slice(0, 40)}#x&y` }],
  ])("refuses to render with %s, so no message goes out with a link that cannot work", async (_name, data) => {
    await expect(render("en", data)).rejects.toThrow(RangeError);
  });
});

describe("the email-change notice and the origin", () => {
  it("points its link to the origin of the configuration, not to a host in the data", async () => {
    const rendered = await render("en", { displayName: "x", token: TOKEN, link: "https://evil.example/", appOrigin: "https://evil.example" });
    expect(linksOf(rendered.html)).toEqual([LINK]);
    const other = createMailTemplates({ appOrigin: "http://localhost:5173/" }).emailChangeNotice;
    expect(other?.({ data: { displayName: "x", token: TOKEN }, locale: "en" }).text).toContain(`http://localhost:5173/email-change/cancel#token=${TOKEN}`);
  });
});
