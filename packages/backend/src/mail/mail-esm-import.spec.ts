import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mailDir = dirname(fileURLToPath(import.meta.url));

describe("mail module ESM imports", () => {
  it("SmtpMailService does not statically import MailRuntimeService", () => {
    const source = readFileSync(join(mailDir, "smtp-mail.service.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/mail-runtime\.service\.js["']/);
  });

  it("loads mail services without circular initialization (production-like order)", async () => {
    const smtpModule = await import("./smtp-mail.service.js");
    const runtimeModule = await import("./mail-runtime.service.js");

    expect(smtpModule.SmtpMailService).toBeTypeOf("function");
    expect(runtimeModule.MailRuntimeService).toBeTypeOf("function");
  });
});
