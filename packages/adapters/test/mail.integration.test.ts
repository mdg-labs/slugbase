import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpEgress, createSmtpMail, type MailTemplates } from "../src/index.ts";

// The SMTP adapter against a real SMTP server: Mailpit catches the message and its API reads it back
// (doc 08 section 1.2). The CI integration job runs Mailpit as the service `mailpit`; a developer runs
// `docker compose -f compose.dev.yml up -d mailpit`, which publishes it on loopback. The API is read
// through the egress adapter, the only code that makes outbound HTTP requests (T6).

const HOST = process.env["GITHUB_ACTIONS"] === "true" ? "mailpit" : "127.0.0.1";
const SMTP_PORT = 1025;
const API = `http://${HOST}:8025`;

const egress = new HttpEgress({ nodeEnv: "test", testOnly: { allowNonPublicAddresses: true } });

async function getJson<T>(path: string): Promise<T> {
  const response = await egress.request({ url: `${API}${path}`, timeoutMs: 10_000, maxBytes: 1_048_576, acceptContentTypes: ["application/json"] });
  expect(response.status).toBe(200);
  return JSON.parse(Buffer.from(response.body).toString("utf8")) as T;
}

interface Summary {
  ID: string;
}

interface Stored {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
  From: { Name: string; Address: string };
  To: { Address: string }[];
  Cc: unknown[] | null;
  Bcc: unknown[] | null;
}

const templates: MailTemplates = {
  welcome: ({ data, locale }) => ({
    subject: `Welcome, ${String(data["name"])}`,
    text: `Hello ${String(data["name"])}, your language is ${locale}.`,
    html: `<p>Hello <strong>${String(data["name"])}</strong>, your language is ${locale}.</p>`,
    headers: { "X-Slugbase-Test": "mailpit" },
  }),
};

async function messageTo(address: string): Promise<Stored> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = await getJson<{ messages: Summary[] }>(`/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const first = found.messages[0];
    if (first !== undefined) {
      expect(found.messages).toHaveLength(1);
      return getJson<Stored>(`/api/v1/message/${first.ID}`);
    }
    if (Date.now() > deadline) {
      throw new Error("Mailpit did not receive the message");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("the SMTP mail adapter against Mailpit", () => {
  const mail = createSmtpMail({
    host: HOST,
    port: SMTP_PORT,
    security: "none",
    from: "SlugBase <slugbase@example.test>",
    templates,
  });

  it("delivers one message with its recipient, subject and both parts", async () => {
    const recipient = `member-${randomBytes(6).toString("hex")}@example.test`;
    await mail.send({ template: "welcome", to: recipient, locale: "de", data: { name: "Ada" } });
    const stored = await messageTo(recipient);
    expect(stored.To.map((to) => to.Address)).toEqual([recipient]);
    expect(stored.Subject).toBe("Welcome, Ada");
    expect(stored.Text).toContain("Hello Ada, your language is de.");
    expect(stored.HTML).toContain("<strong>Ada</strong>");
    expect(stored.From).toMatchObject({ Name: "SlugBase", Address: "slugbase@example.test" });
    expect(stored.Cc ?? []).toEqual([]);
    expect(stored.Bcc ?? []).toEqual([]);
    const headers = await getJson<Record<string, string[]>>(`/api/v1/message/${stored.ID}/headers`);
    expect(headers["X-Slugbase-Test"]).toEqual(["mailpit"]);
  });

  it("delivers nothing for a recipient with a line break", async () => {
    const marker = randomBytes(6).toString("hex");
    await expect(
      mail.send({ template: "welcome", to: `a-${marker}@example.test\r\nBcc: b-${marker}@example.test`, locale: "en", data: { name: "Ada" } }),
    ).rejects.toMatchObject({ reason: "invalid_message" });
    const found = await getJson<{ messages: Summary[] }>(`/api/v1/search?query=${encodeURIComponent(marker)}`);
    expect(found.messages).toEqual([]);
  });
});
