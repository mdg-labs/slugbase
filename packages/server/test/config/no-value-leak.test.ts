import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, composeEnvSchema, envFragment, loadConfig, requireAllOrNone, validateEnvironment } from "../../src/config/index.ts";
import { DEVELOPMENT_DATABASE_URL, DEVELOPMENT_ENCRYPTION_KEY, DEVELOPMENT_SESSION_SECRET } from "../../src/config/development-defaults.ts";
import { productionEnv } from "./support.ts";

// T7: a weak or malformed value is never echoed. Each row is a value the
// schema refuses; the sentinel is the value itself, so the assertion below
// fails if it reaches the message, the issues, the cause, the stack or any
// own property of the thrown object.
const REFUSED: readonly { key: string; value: string }[] = [
  { key: "SESSION_SECRET", value: "weak-session-qx41" },
  { key: "SESSION_SECRET", value: DEVELOPMENT_SESSION_SECRET },
  { key: "ENCRYPTION_KEY", value: "bad-key-qx42-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  { key: "ENCRYPTION_KEY", value: Buffer.alloc(16, 9).toString("base64") },
  { key: "ENCRYPTION_KEY", value: DEVELOPMENT_ENCRYPTION_KEY },
  { key: "ENCRYPTION_KEY_ID", value: "bad id qx43/with:chars" },
  { key: "ENCRYPTION_KEY_PREVIOUS", value: "qx63:bad-previous-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  { key: "APP_ORIGIN", value: "http://insecure-qx44.example.com" },
  { key: "APP_ORIGIN", value: "https://qx45.example.com/with/a/path" },
  { key: "DATABASE_URL", value: DEVELOPMENT_DATABASE_URL },
  { key: "DATABASE_URL", value: "postgres://user:pw-qx46@:5432/app" },
  { key: "DATABASE_URL", value: "postgres://app:slugbase_app_dev_only@qx47.internal/app" },
  { key: "DATABASE_URL", value: "mysql://user:pw-qx48@db.internal/app" },
  { key: "DATABASE_MIGRATE_URL", value: "postgres://slugbase_migrator:slugbase_migrator_dev_only@qx49.internal/app" },
  { key: "PORT", value: "port-qx50" },
  { key: "TRUSTED_PROXY_HOPS", value: "hops-qx51" },
  { key: "LOG_LEVEL", value: "level-qx52" },
  { key: "API_DOCS_ENABLED", value: "maybe-qx53" },
  { key: "MIGRATE_ON_START", value: "maybe-qx54" },
  { key: "SETUP_ENABLED", value: "maybe-qx90" },
  { key: "SETUP_TOKEN_REQUIRED", value: "maybe-qx91" },
  { key: "BREACHED_PASSWORD_CHECK", value: "maybe-qx92" },
  { key: "SLUGBASE_ALLOW_OWNER_CONNECTION", value: "maybe-qx55" },
  { key: "DOCS_BASE_URL", value: "ftp://qx56.example.com/docs" },
  { key: "NODE_ENV", value: "prod-qx57" },
  { key: "ERROR_REPORT_DSN", value: "https://qx64-key@errors.example.com/not-a-project" },
  { key: "SMTP_HOST", value: "smtp://qx71.example.com" },
  { key: "SMTP_PORT", value: "port-qx72" },
  { key: "SMTP_SECURITY", value: "security-qx73" },
  { key: "SMTP_FROM", value: "from-qx74" },
];

// The message, the stack, the cause and every own property, however they are rendered.
function everything(error: unknown): string {
  const parts = [inspect(error, { depth: null, showHidden: true }), JSON.stringify(error)];
  if (error instanceof Error) {
    parts.push(error.message, error.stack ?? "", inspect(error.cause, { depth: null }));
  }
  return parts.join("\n");
}

describe("configuration errors never contain a value (T7)", () => {
  it.each(REFUSED)("$key rejects $value without echoing it", ({ key, value }) => {
    const logged: string[] = [];
    let thrown: unknown;
    try {
      loadConfig("server", productionEnv({ [key]: value }));
    } catch (error) {
      thrown = error;
      if (error instanceof ConfigError) {
        logged.push(JSON.stringify({ level: "error", msg: error.message, keys: error.issues.map((issue) => issue.key) }));
      }
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues.map((issue) => issue.key)).toContain(key);
    expect(everything(thrown)).not.toContain(value);
    expect(logged.join("\n")).not.toContain(value);
  });

  it("does not echo the other values of the environment either", () => {
    const env = productionEnv({ SESSION_SECRET: "weak-qx60" });
    let thrown: unknown;
    try {
      loadConfig("server", env);
    } catch (error) {
      thrown = error;
    }
    for (const [key, value] of Object.entries(env)) {
      if (key !== "NODE_ENV" && value !== undefined) {
        expect(everything(thrown)).not.toContain(value);
      }
    }
  });

  it("does not echo the values of a partial adapter key set", () => {
    const smtp = envFragment({
      shape: { SMTP_HOST: z.string().optional(), SMTP_PASS: z.string().optional() },
      refine(values, context) {
        requireAllOrNone(["SMTP_HOST", "SMTP_PASS"], values, context);
      },
    });
    let thrown: unknown;
    try {
      validateEnvironment(composeEnvSchema([smtp]), { SMTP_HOST: "smtp-host-qx61.example.com" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(everything(thrown)).not.toContain("smtp-host-qx61");
  });

  it("does not echo the value of an unknown SLUGBASE_* key", () => {
    const { warnings } = loadConfig("server", { ...productionEnv(), SLUGBASE_UNKNOWN: "secret-qx62" });
    expect(warnings.join("\n")).not.toContain("secret-qx62");
    expect(warnings.join("\n")).toContain("SLUGBASE_UNKNOWN");
  });

  it("does not echo the value of TRUSTED_PROXY_HOPS in its warning", () => {
    const { warnings } = loadConfig("server", productionEnv({ TRUSTED_PROXY_HOPS: "0" }));
    const warning = warnings.find((candidate) => candidate.includes("TRUSTED_PROXY_HOPS"));
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/\d/);
  });
});
