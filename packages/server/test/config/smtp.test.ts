import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, SMTP_KEYS } from "../../src/config/index.ts";
import { productionEnv } from "./support.ts";

const SMTP = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURITY: "starttls",
  SMTP_USER: "relay-user",
  SMTP_PASS: "relay-pass-qx70",
  SMTP_FROM: "SlugBase <slugbase@example.com>",
};

function issues(type: "server" | "worker", overrides: Record<string, string | undefined>): { key: string; message: string }[] {
  try {
    loadConfig(type, productionEnv(overrides));
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...error.issues];
    }
    throw error;
  }
  return [];
}

describe("the SMTP keys", () => {
  it.each(["server", "worker"] as const)("%s: with none set, the mail adapter is not configured", (type) => {
    const { config } = loadConfig(type, productionEnv());
    for (const key of SMTP_KEYS) {
      expect(config[key]).toBeUndefined();
    }
  });

  it.each(["server", "worker"] as const)("%s: treats empty values as unset", (type) => {
    const { config } = loadConfig(type, productionEnv(Object.fromEntries(SMTP_KEYS.map((key) => [key, ""]))));
    expect(config.SMTP_HOST).toBeUndefined();
  });

  it.each(["server", "worker"] as const)("%s: with all set, parses them", (type) => {
    const { config } = loadConfig(type, productionEnv(SMTP));
    expect(config).toMatchObject({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 587,
      SMTP_SECURITY: "starttls",
      SMTP_USER: "relay-user",
      SMTP_PASS: "relay-pass-qx70",
      SMTP_FROM: "SlugBase <slugbase@example.com>",
    });
  });

  it("is not part of the migrate command", () => {
    expect(() => loadConfig("migrate", productionEnv(SMTP))).not.toThrow();
    expect(loadConfig("migrate", productionEnv(SMTP)).config).not.toHaveProperty("SMTP_HOST");
  });

  it.each(SMTP_KEYS)("refuses a set without %s, naming exactly that key", (missing) => {
    const found = issues("server", { ...SMTP, [missing]: undefined });
    expect(found.map((issue) => issue.key)).toEqual([missing]);
    expect(issues("worker", { ...SMTP, [missing]: undefined }).map((issue) => issue.key)).toEqual([missing]);
  });

  it("names every missing key of a partial set", () => {
    const found = issues("server", { SMTP_HOST: SMTP.SMTP_HOST });
    expect(found.map((issue) => issue.key).sort()).toEqual(["SMTP_FROM", "SMTP_PASS", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER"]);
  });

  it.each([
    ["SMTP_HOST", "smtp://smtp.example.com"],
    ["SMTP_HOST", "smtp.example.com:587"],
    ["SMTP_HOST", "smtp.example.com/path"],
    ["SMTP_PORT", "0"],
    ["SMTP_PORT", "70000"],
    ["SMTP_PORT", "five"],
    ["SMTP_SECURITY", "ssl"],
    ["SMTP_SECURITY", "TLS"],
    ["SMTP_FROM", "not-an-address"],
    ["SMTP_FROM", "a@example.com\r\nBcc: b@example.com"],
    ["SMTP_FROM", "a@example.com, b@example.com"],
    ["SMTP_FROM", "Name <a@example.com\nBcc: b@example.com>"],
  ])("refuses %s=%s", (key, value) => {
    expect(issues("server", { ...SMTP, [key]: value }).map((issue) => issue.key)).toEqual([key]);
  });

  it.each(["smtp.example.com", "localhost", "192.0.2.10", "2001:db8::25"])("accepts SMTP_HOST=%s", (host) => {
    expect(loadConfig("server", productionEnv({ ...SMTP, SMTP_HOST: host })).config.SMTP_HOST).toBe(host);
  });

  it.each(["tls", "starttls", "none"])("accepts SMTP_SECURITY=%s", (security) => {
    expect(loadConfig("server", productionEnv({ ...SMTP, SMTP_SECURITY: security })).config.SMTP_SECURITY).toBe(security);
  });

  it("accepts a plain address as the sender", () => {
    expect(loadConfig("server", productionEnv({ ...SMTP, SMTP_FROM: "slugbase@example.com" })).config.SMTP_FROM).toBe("slugbase@example.com");
  });

  it("does not echo the credentials of a partial set", () => {
    let thrown: unknown;
    try {
      loadConfig("server", productionEnv({ SMTP_USER: SMTP.SMTP_USER, SMTP_PASS: SMTP.SMTP_PASS }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).not.toContain(SMTP.SMTP_PASS);
    expect((thrown as ConfigError).message).not.toContain(SMTP.SMTP_USER);
  });
});
