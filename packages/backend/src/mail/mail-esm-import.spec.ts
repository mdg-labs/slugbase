import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mailDir = dirname(fileURLToPath(import.meta.url));

describe("mail module ESM imports", () => {
  it("loads SmtpMailService without circular initialization", async () => {
    const smtpModule = await import("./smtp-mail.service.js");
    expect(smtpModule.SmtpMailService).toBeTypeOf("function");
  });

  it("SmtpMailService source does not reference DB hydration", () => {
    const source = readFileSync(join(mailDir, "smtp-mail.service.ts"), "utf8");
    expect(source).not.toMatch(/smtp_settings/);
    expect(source).not.toMatch(/reconfigureFromEncrypted/);
  });
});
