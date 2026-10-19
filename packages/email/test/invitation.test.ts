import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The invitation email (doc 02 section 3.4): rendered in the invitee's language, or the inviter's, with a
// plain-text part, no tracking element and one link, to /invite/<token> on the deployment's own origin. It names
// the workspace, the person who invited and the role, which are other people's data and so are escaped and
// kept on one line, and it greets nobody by name because the address may have no account.

const ORIGIN = "https://bookmarks.example.com";
const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const LINK = `${ORIGIN}/invite/${TOKEN}`;
const templates = createMailTemplates({ appOrigin: ORIGIN });
const DATA = { workspaceName: "Compilers", inviterName: "Ada Lovelace", role: "admin", token: TOKEN, expiresOn: "2026-10-26" };

async function render(locale: string, data: Record<string, string> = DATA) {
  const mail = new InMemoryMail();
  await mail.send({ template: "invitation", to: "grace@example.test", locale, data });
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

describe("the invitation template", () => {
  it("renders English, naming the workspace, the inviter and the role, and the day the link ends", async () => {
    const rendered = await render("en");
    expect(rendered.subject).toBe("Ada Lovelace invited you to Compilers on SlugBase");
    expect(rendered.text).toContain("Ada Lovelace invited you to join the workspace Compilers on SlugBase as an admin.");
    expect(rendered.text).toContain("The link works once and until 2026-10-26.");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("renders German", async () => {
    const rendered = await render("de");
    expect(rendered.subject).toBe("Ada Lovelace hat dich zu Compilers auf SlugBase eingeladen");
    expect(rendered.text).toContain("Ada Lovelace hat dich eingeladen, dem Workspace Compilers auf SlugBase als Admin beizutreten.");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it("names the member role", async () => {
    expect((await render("en", { ...DATA, role: "member" })).text).toContain("as a member.");
    expect((await render("de", { ...DATA, role: "member" })).text).toContain("als Mitglied beizutreten.");
  });

  it("falls back to English for a language it has no catalog for", async () => {
    expect((await render("fr")).subject).toBe("Ada Lovelace invited you to Compilers on SlugBase");
  });

  it("leaves the inviter out when it is no longer known", async () => {
    const rendered = await render("en", { ...DATA, inviterName: " " });
    expect(rendered.subject).toBe("You are invited to Compilers on SlugBase");
    expect(rendered.text).toContain("You are invited to join the workspace Compilers on SlugBase as an admin.");
    expect(rendered.text).not.toContain("Ada");
  });

  it("greets nobody by name", async () => {
    expect((await render("en")).text.startsWith("Hi,\n")).toBe(true);
    expect((await render("de")).text.startsWith("Hallo,\n")).toBe(true);
  });

  it.each(["en", "de"])("links once to /invite/<token> on the origin, in both parts (%s)", async (locale) => {
    const rendered = await render(locale);
    expect(linksOf(rendered.text)).toEqual([LINK]);
    expect(linksOf(rendered.html)).toEqual([LINK]);
    expect(rendered.html.match(/\bhref="[^"]*"/g)).toEqual([`href="${LINK}"`]);
    expect(rendered.text).not.toContain("<");
  });

  it.each(["en", "de"])("holds no tracking element, remote asset or script (%s)", async (locale) => {
    const { html } = await render(locale);
    expect(html).not.toMatch(/<(img|script|iframe|link|object|embed|video|audio|source|style)\b/i);
    expect(html).not.toMatch(/\burl\(/i);
    expect(html).not.toMatch(/\bsrc=/i);
    expect(html).not.toMatch(/[?&](utm_|track)/i);
  });

  it("escapes the workspace and the inviter in the HTML part and keeps them on one line in the subject", async () => {
    const rendered = await render("en", { ...DATA, workspaceName: '<img src="https://tracker.example/p.gif">', inviterName: "Ada\r\nBcc: someone@example.test" });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it("points its link to the origin of the configuration, not to a host in the data", async () => {
    const rendered = await render("en", { ...DATA, link: "https://evil.example/", appOrigin: "https://evil.example" });
    expect(linksOf(rendered.html)).toEqual([LINK]);
  });

  it.each([
    ["a missing token", { ...DATA, token: "" }],
    ["a token of the wrong length", { ...DATA, token: "short" }],
    ["a token with a character a link cannot carry", { ...DATA, token: `${TOKEN.slice(0, 42)}/` }],
    ["the owner role, which no invitation grants", { ...DATA, role: "owner" }],
    ["no role", { ...DATA, role: "" }],
    ["no workspace name", { ...DATA, workspaceName: "  " }],
    ["a date that is not a date", { ...DATA, expiresOn: "next week" }],
  ])("refuses to render with %s, so no message goes out that names nothing or links to nothing that works", async (_name, data) => {
    await expect(render("en", data)).rejects.toThrow(RangeError);
  });
});
