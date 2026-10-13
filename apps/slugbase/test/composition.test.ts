import { randomBytes } from "node:crypto";
import { unconfigured, type Adapters } from "@slugbase/core";
import { loadConfig, type Logger } from "@slugbase/server";
import { describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The composition root builds the five CE adapters from configuration (doc 09
// section 2.1); the other ports stay at the unconfigured defaults (D22).

const warnings: string[] = [];
const logger: Logger = { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined };

const environment = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
  MIGRATE_ON_START: "false",
};

const configured = {
  ...environment,
  ERROR_REPORT_DSN: "https://publickey@errors.example.com/1",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURITY: "starttls",
  SMTP_FROM: "SlugBase <slugbase@example.com>",
};

const FIVE = ["egress", "secretBox", "rateLimit", "mail", "errors"] as const satisfies readonly (keyof Adapters)[];
const REST = ["ai", "identity", "analytics", "clientErrorReport", "challenge", "tenantResolver"] as const satisfies readonly (keyof Adapters)[];

describe("the CE adapters of the composition root", () => {
  it("are not the unconfigured placeholders when the operator configured mail and error reporting", () => {
    const config = loadConfig("server", configured).config;
    const adapters = composeAdapters(config, logger);
    const placeholders = unconfigured();
    for (const port of FIVE) {
      expect(adapters[port], port).not.toBe(placeholders[port]);
      expect(adapters[port].available, port).toBe(true);
    }
  });

  it("are real adapters for the worker too, and the unavailable ones are the adapters that report so", async () => {
    const config = loadConfig("worker", environment).config;
    const adapters = composeAdapters(config, logger);
    for (const port of ["egress", "secretBox", "rateLimit"] as const) {
      expect(adapters[port].available, port).toBe(true);
    }
    // Without SMTP keys and a DSN, mail is the log-only adapter, which says it is off and logs what it
    // refused; the unconfigured placeholder rejects in silence.
    expect(adapters.mail.available).toBe(false);
    expect(adapters.errors.available).toBe(false);
    warnings.length = 0;
    await expect(adapters.mail.send({ template: "welcome", to: "member@example.org", locale: "en", data: {} })).rejects.toMatchObject({
      code: "mail_unavailable",
    });
    expect(warnings).toEqual(["Mail is not configured; the message was not sent"]);
  });

  it("leave every other port at its unconfigured default", () => {
    const config = loadConfig("server", configured).config;
    const adapters = composeAdapters(config, logger);
    for (const port of REST) {
      expect(adapters[port].available, port).toBe(false);
    }
  });
});
