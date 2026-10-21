import { InMemoryMail } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { createMailTemplates } from "../src/index.ts";

// The test email of the instance admin (doc 02 section 11.3): it says that delivery works and links nowhere.

const templates = createMailTemplates({ appOrigin: "https://bookmarks.example.com" });

async function render(locale: string, data: Record<string, string> = { displayName: "Ada Lovelace" }) {
  const mail = new InMemoryMail();
  await mail.send({ template: "testMail", to: "ada@example.test", locale, data });
  const message = mail.sent[0];
  const template = message === undefined ? undefined : templates[message.template];
  if (message === undefined || template === undefined) {
    throw new Error("the message was not captured or has no template");
  }
  return template({ data: message.data, locale: message.locale });
}

describe("the test mail template", () => {
  it("renders English and German, addressed by name, with a text part that names why it arrived", async () => {
    const en = await render("en");
    expect(en.subject).toBe("SlugBase test email");
    expect(en.text).toContain("Hi Ada Lovelace,");
    expect(en.text).toContain("an instance administrator asked SlugBase to send a test email");
    expect(en.html).toContain('<html lang="en">');
    const de = await render("de");
    expect(de.subject).toBe("SlugBase-Testmail");
    expect(de.text).toContain("Hallo Ada Lovelace,");
    expect(de.html).toContain('<html lang="de">');
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
