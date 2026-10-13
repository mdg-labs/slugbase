import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { PortUnavailable } from "@slugbase/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailError, createLogOnlyMail, createSmtpMail, type MailTemplates } from "../src/index.ts";

const templates: MailTemplates = {
  welcome: ({ data, locale }) => ({
    subject: `Welcome ${String(data["name"])}`,
    text: `Hello ${String(data["name"])} (${locale})`,
    html: `<p>Hello ${String(data["name"])}</p>`,
  }),
  injected: () => ({ subject: "Hello\r\nBcc: attacker@example.test", text: "t", html: "<p>t</p>" }),
  headers: ({ data }) => ({ subject: "s", text: "t", html: "<p>t</p>", headers: { [String(data["name"])]: String(data["value"]) } }),
};

const message = (overrides: Partial<{ template: string; to: string; data: Record<string, string> }> = {}) => ({
  template: "welcome",
  to: "member@example.test",
  locale: "en",
  data: { name: "Ada" },
  ...overrides,
});

describe("the log-only mail adapter", () => {
  it("is unavailable, logs the recipient domain and template only, and rejects with mail_unavailable", async () => {
    const logged: { message: string; fields: unknown }[] = [];
    const mail = createLogOnlyMail({ logger: { warn: (text, fields) => logged.push({ message: text, fields }) } });
    expect(mail.available).toBe(false);
    const error = await mail
      .send({ template: "reset", to: "Ada.Lovelace@Example.Test", locale: "de", data: { link: "https://x.test/t/secrettoken", code: 123456 } })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(PortUnavailable);
    expect(error).toMatchObject({ port: "mail", code: "mail_unavailable" });
    expect(logged).toEqual([
      { message: "Mail is not configured; the message was not sent", fields: { recipientDomain: "example.test", template: "reset" } },
    ]);
  });

  it("logs unknown for a recipient it cannot read a domain from", async () => {
    const logged: unknown[] = [];
    const mail = createLogOnlyMail({ logger: { warn: (_text, fields) => logged.push(fields) } });
    await mail.send({ template: "t", to: "no-at-sign", locale: "en", data: {} }).catch(() => undefined);
    await mail.send({ template: "t", to: "a@b.test\r\n", locale: "en", data: {} }).catch(() => undefined);
    expect(logged).toEqual([
      { recipientDomain: "unknown", template: "t" },
      { recipientDomain: "unknown", template: "t" },
    ]);
  });
});

// Nothing listens here: a message refused before the connection answers with its own reason, and one that
// reaches the connection answers delivery_failed.
const UNREACHABLE = { host: "127.0.0.1", port: 9, security: "none", from: "slugbase@example.test", templates, timeoutMs: 2_000 } as const;

describe("the SMTP mail adapter", () => {
  it("is available", () => {
    expect(createSmtpMail(UNREACHABLE).available).toBe(true);
  });

  it.each([
    ["a recipient with a line feed", message({ to: "a@example.test\nBcc: b@example.test" })],
    ["a recipient with a carriage return", message({ to: "a@example.test\rBcc: b@example.test" })],
    ["a list of recipients", message({ to: "a@example.test, b@example.test" })],
    ["a recipient with a display name", message({ to: "Ada <a@example.test>" })],
    ["a recipient without a domain", message({ to: "a" })],
    ["a subject with a line break", message({ template: "injected" })],
    ["a header value with a line break", message({ template: "headers", data: { name: "X-Note", value: "a\r\nBcc: b@example.test" } })],
    ["a header name with a line break", message({ template: "headers", data: { name: "X-Note\r\nBcc", value: "a" } })],
    ["a header that sets a recipient", message({ template: "headers", data: { name: "Bcc", value: "b@example.test" } })],
    ["a header that replaces the content type", message({ template: "headers", data: { name: "content-type", value: "text/plain" } })],
  ])("refuses %s before any connection", async (_name, refused) => {
    const error = await createSmtpMail(UNREACHABLE)
      .send(refused)
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(MailError);
    expect(error).toMatchObject({ reason: "invalid_message" });
  });

  it("refuses a template it does not have, including one named like an inherited property", async () => {
    for (const template of ["missing", "toString", "__proto__"]) {
      await expect(createSmtpMail(UNREACHABLE).send(message({ template }))).rejects.toMatchObject({ reason: "unknown_template" });
    }
  });

  it("answers delivery_failed, carrying nothing of the message, when the relay cannot be reached", async () => {
    const error = await createSmtpMail(UNREACHABLE)
      .send(message({ data: { name: "Ada-seed-marker" } }))
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ name: "MailError", reason: "delivery_failed" });
    expect(JSON.stringify(error) + (error as Error).message + ((error as Error).stack ?? "")).not.toContain("seed-marker");
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("the SMTP mail adapter and the relay's certificate", () => {
  let directory: string;
  let certificate: { key: string; cert: string };

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "mail-tls-"));
    const keyFile = join(directory, "relay.key");
    const certFile = join(directory, "relay.crt");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
      { stdio: "ignore" },
    );
    certificate = { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const servers: (Server | TlsServer)[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  async function listen(server: Server | TlsServer): Promise<number> {
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return (server.address() as { port: number }).port;
  }

  it("refuses a self-signed certificate over implicit TLS: no session is established and nothing is sent", async () => {
    let sessions = 0;
    const relay = createTlsServer(certificate, (socket) => {
      sessions += 1;
      socket.write("220 relay ready\r\n");
      socket.on("error", () => undefined);
    });
    relay.on("tlsClientError", () => undefined);
    const port = await listen(relay);
    const mail = createSmtpMail({ ...UNREACHABLE, host: "127.0.0.1", port, security: "tls" });
    await expect(mail.send(message())).rejects.toMatchObject({ reason: "delivery_failed" });
    expect(sessions).toBe(0);
  });

  it("refuses to send in plain text when STARTTLS is required and the relay does not offer it", async () => {
    const received: string[] = [];
    const relay = createServer((socket) => {
      socket.write("220 relay ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("latin1");
        received.push(text);
        if (/^EHLO/i.test(text)) {
          socket.write("250-relay\r\n250 8BITMIME\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      });
      socket.on("error", () => undefined);
    });
    const port = await listen(relay);
    const mail = createSmtpMail({ ...UNREACHABLE, host: "127.0.0.1", port, security: "starttls" });
    await expect(mail.send(message())).rejects.toMatchObject({ reason: "delivery_failed" });
    expect(received.join("")).not.toMatch(/MAIL FROM|RCPT TO|DATA/i);
  });
});
