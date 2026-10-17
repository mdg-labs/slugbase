import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The "new sign-in" email (doc 02 section 12): the time (UTC), the browser family and the coarse network
// prefix, in the recipient's language with a plain-text part, no tracking element, and one link, to the
// deployment's own origin. It never shows a full address.

const ORIGIN = "https://bookmarks.example.com";
const LINK = `${ORIGIN}/settings/account/security`;
const templates = createMailTemplates({ appOrigin: ORIGIN });
const DATA = { displayName: "Ada Lovelace", signedInAt: "2026-10-17T17:09:24.000Z", browser: "Firefox", network: "203.0.0.0/16" };

async function render(locale: string, data: Record<string, string> = DATA) {
  const mail = new InMemoryMail();
  await mail.send({ template: "newSignIn", to: "ada@example.test", locale, data });
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

describe("the new sign-in email template", () => {
  it("renders English with the time, the browser and the network, addressed by name", async () => {
    const rendered = await render("en");
    expect(rendered.subject).toBe("New sign-in to your SlugBase account");
    expect(rendered.text).toContain("Hi Ada Lovelace,");
    expect(rendered.text).toContain("Time: October 17, 2026 at 5:09 PM UTC");
    expect(rendered.text).toContain("Browser: Firefox");
    expect(rendered.text).toContain("Network: 203.0.0.0/16");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("renders German for a German recipient", async () => {
    const rendered = await render("de");
    expect(rendered.subject).toBe("Neue Anmeldung bei deinem SlugBase-Konto");
    expect(rendered.text).toContain("Hallo Ada Lovelace,");
    expect(rendered.text).toContain("Zeit: 17. Oktober 2026 um 17:09 UTC");
    expect(rendered.text).toContain("Browser: Firefox");
    expect(rendered.text).toContain("Netzwerk: 203.0.0.0/16");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it("falls back to English for a language it has no catalog for", async () => {
    expect((await render("fr")).subject).toBe("New sign-in to your SlugBase account");
  });

  it("greets without a name when the account has none", async () => {
    expect((await render("en", { ...DATA, displayName: " " })).text.startsWith("Hi,\n")).toBe(true);
  });

  it("shows an IPv6 /48 prefix", async () => {
    expect((await render("en", { ...DATA, network: "2001:db8:abcd::/48" })).text).toContain("Network: 2001:db8:abcd::/48");
  });

  it.each([
    ["en", "Unknown"],
    ["de", "Unbekannt"],
  ])("shows a browser or network that is missing as unknown (%s)", async (locale, unknown) => {
    const { text } = await render(locale, { displayName: "Ada", signedInAt: DATA.signedInAt });
    expect(text).toContain(`Browser: ${unknown}`);
    expect(text).toContain(`${locale === "en" ? "Network" : "Netzwerk"}: ${unknown}`);
  });

  it.each(["en", "de"])("links once to the security settings, in both parts (%s)", async (locale) => {
    const rendered = await render(locale);
    expect(linksOf(rendered.text)).toEqual([LINK]);
    expect(linksOf(rendered.html)).toEqual([LINK]);
    expect(rendered.text).not.toContain("<");
  });

  it.each(["en", "de"])("holds no tracking element, remote asset or script (%s)", async (locale) => {
    const { html } = await render(locale);
    expect(html).not.toMatch(/<(img|script|iframe|link|object|embed|video|audio|source|style)\b/i);
    expect(html).not.toMatch(/\burl\(/i);
    expect(html).not.toMatch(/\bsrc=/i);
  });

  it("escapes the name, the browser and the network in the HTML part", async () => {
    const { html } = await render("en", { ...DATA, displayName: '<img src="https://tracker.example/p.gif">', browser: "<b>x</b>" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it.each([
    ["a missing time", { displayName: "Ada", browser: "Firefox" }],
    ["a time that is not a time", { ...DATA, signedInAt: "yesterday" }],
    ["a full IPv4 address", { ...DATA, network: "203.0.113.57" }],
    ["a full IPv4 address with its length", { ...DATA, network: "203.0.113.57/32" }],
    ["a full IPv6 address", { ...DATA, network: "2001:db8:abcd:12:3456:789a:bcde:f012/128" }],
    ["text where a prefix belongs", { ...DATA, network: "home" }],
  ])("refuses to render with %s, so no message goes out with a wrong time or an address", async (_name, data) => {
    await expect(render("en", data)).rejects.toThrow(RangeError);
  });

  it("points its link to the origin of the configuration, not to a host in the data", async () => {
    const rendered = await render("en", { ...DATA, link: "https://evil.example/", appOrigin: "https://evil.example" });
    expect(linksOf(rendered.html)).toEqual([LINK]);
  });
});
