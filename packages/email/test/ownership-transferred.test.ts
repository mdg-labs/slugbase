import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The "ownership transferred to you" email (doc 02 section 12): rendered in the recipient's language with a
// plain-text part, no tracking element and links only to the deployment's origin. It names the workspace and the
// owner who made the change, both of which are the data of other people and so are escaped and kept on one line.

const ORIGIN = "https://bookmarks.example.com";
const templates = createMailTemplates({ appOrigin: ORIGIN });
const DATA = { displayName: "Grace Hopper", workspaceName: "Compilers", transferredBy: "Ada Lovelace" };

async function render(locale: string, data: Record<string, string> = DATA) {
  const mail = new InMemoryMail();
  await mail.send({ template: "ownershipTransferred", to: "grace@example.test", locale, data });
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

describe("the ownership transferred template", () => {
  it("renders English for an English recipient, naming the workspace and the owner who made the change", async () => {
    const { message, rendered } = await render("en");
    expect(message.to).toBe("grace@example.test");
    expect(rendered.subject).toBe("You are now an owner of Compilers on SlugBase");
    expect(rendered.text).toContain("Hi Grace Hopper,");
    expect(rendered.text).toContain("Ada Lovelace made you an owner of the workspace Compilers on SlugBase.");
    expect(rendered.html).toContain('<html lang="en">');
    expect(rendered.html).toContain("Ada Lovelace made you an owner of the workspace Compilers on SlugBase.");
  });

  it("renders German for a German recipient", async () => {
    const { rendered } = await render("de");
    expect(rendered.subject).toBe("Du bist jetzt Eigentümer von Compilers auf SlugBase");
    expect(rendered.text).toContain("Hallo Grace Hopper,");
    expect(rendered.text).toContain("Ada Lovelace hat dich zum Eigentümer des Workspace Compilers auf SlugBase gemacht.");
    expect(rendered.html).toContain('<html lang="de">');
  });

  it("falls back to English for a language it has no catalog for", async () => {
    const { rendered } = await render("fr");
    expect(rendered.subject).toBe("You are now an owner of Compilers on SlugBase");
    expect(rendered.html).toContain('<html lang="en">');
  });

  it("does not name the previous owner when they are no longer known, and greets without a name when the account has none", async () => {
    const { rendered } = await render("en", { displayName: " ", workspaceName: "Compilers", transferredBy: "" });
    expect(rendered.text.startsWith("Hi,\n")).toBe(true);
    expect(rendered.text).toContain("You were made an owner of the workspace Compilers on SlugBase.");
    expect(rendered.text).not.toContain(" made you an owner");
  });

  it("refuses to render without the name of the workspace, rather than sending a message that names nothing", async () => {
    await expect(render("en", { displayName: "Grace", transferredBy: "Ada" })).rejects.toThrow(RangeError);
    await expect(render("en", { displayName: "Grace", workspaceName: "  ", transferredBy: "Ada" })).rejects.toThrow(RangeError);
  });

  it.each(["en", "de"])("has a text part with the same single link as the HTML part, to the deployment's origin (%s)", async (locale) => {
    const { rendered } = await render(locale);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.text).not.toContain("<");
    expect(linksOf(rendered.text)).toEqual([`${ORIGIN}/`]);
    expect(linksOf(rendered.html)).toEqual([`${ORIGIN}/`]);
  });

  it.each(["en", "de"])("holds no tracking element, remote asset or script (%s)", async (locale) => {
    const { rendered } = await render(locale);
    expect(rendered.html).not.toMatch(/<(img|script|iframe|link|object|embed|video|audio|source|style)\b/i);
    expect(rendered.html).not.toMatch(/\burl\(/i);
    expect(rendered.html).not.toMatch(/\bsrc=/i);
    expect(rendered.html.match(/\bhref="[^"]*"/g)).toEqual([`href="${ORIGIN}/"`]);
    expect(rendered.html).not.toMatch(/[?&](utm_|track)/i);
  });

  it("escapes the workspace's name and the previous owner's name in the HTML part", async () => {
    const hostile = '<img src="https://tracker.example/p.gif">';
    const { rendered } = await render("en", { displayName: hostile, workspaceName: hostile, transferredBy: hostile });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
  });

  it("keeps the subject on one line whatever the workspace's name holds", async () => {
    const { rendered } = await render("en", { displayName: "Grace", workspaceName: "Compilers\r\nBcc: someone@example.test", transferredBy: "Ada" });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject).toBe("You are now an owner of Compilers Bcc: someone@example.test on SlugBase");
  });

  it("points its link to the origin of the configuration, not to a host in the data", async () => {
    const { rendered } = await render("en", { ...DATA, link: "https://evil.example/", appOrigin: "https://evil.example" });
    expect(linksOf(rendered.html).every((link) => link.startsWith(`${ORIGIN}/`))).toBe(true);
    const other = createMailTemplates({ appOrigin: "http://localhost:5173/" }).ownershipTransferred;
    expect(other?.({ data: DATA, locale: "en" }).text).toContain("http://localhost:5173/");
  });
});
