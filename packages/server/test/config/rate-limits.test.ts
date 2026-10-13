import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_SCOPES,
  createRateLimitRegistry,
  declaredKeys,
  loadConfig,
  rateLimitKey,
} from "../../src/config/index.ts";
import { parseEnvFile, productionEnv } from "./support.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const example = parseEnvFile(readFileSync(join(ROOT, ".env.example"), "utf8"));

const rateLimitKeys = RATE_LIMIT_BUCKETS.flatMap((bucket) =>
  RATE_LIMIT_SCOPES.filter((scope) => scope in RATE_LIMIT_DEFAULTS[bucket]).map((scope) => rateLimitKey(bucket, scope)),
);

describe("the RATE_LIMIT_<BUCKET>_<SCOPE> keys", () => {
  it("are declared by the server and the worker, and by nothing else", () => {
    expect(declaredKeys().filter((key) => key.startsWith("RATE_LIMIT_"))).toEqual([...rateLimitKeys].sort());
    expect(() => loadConfig("migrate", productionEnv({ RATE_LIMIT_PUBLIC_IP: "1/min" }))).not.toThrow();
  });

  it("give every bucket a limit per IP, and none of them a per-account limit below it", () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      expect(Object.keys(RATE_LIMIT_DEFAULTS[bucket]), bucket).toContain("ip");
    }
    const registry = createRateLimitRegistry(loadConfig("server", productionEnv()).config);
    for (const bucket of ["token_create", "bulk", "ai"] as const) {
      const perIp = registry.window(bucket);
      const perAccount = registry.window(`${bucket}:account`);
      expect(perIp, bucket).toBeDefined();
      expect(perIp?.capacity, bucket).toBeGreaterThanOrEqual(perAccount?.capacity ?? 0);
    }
  });

  it("are listed in .env.example with the default of doc 04 section 7", () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      for (const [scope, value] of Object.entries<string>(RATE_LIMIT_DEFAULTS[bucket])) {
        expect(example.get(rateLimitKey(bucket, scope as (typeof RATE_LIMIT_SCOPES)[number])), `${bucket} ${scope}`).toBe(value);
      }
    }
  });

  it.each(["server", "worker"] as const)("give %s the defaults of doc 04 section 7 when unset", (type) => {
    const registry = createRateLimitRegistry(loadConfig(type, productionEnv()).config);
    const expected: Record<string, [number, number]> = {
      login: [10, 60],
      "login:email": [20, 3600],
      mfa: [10, 60],
      "mfa:account": [30, 3600],
      register: [5, 3600],
      reset: [5, 3600],
      "reset:email": [3, 3600],
      token_redeem: [10, 3600],
      token_create: [20, 3600],
      "token_create:account": [20, 3600],
      setup: [10, 3600],
      go: [600, 60],
      "go:account": [300, 60],
      read: [1200, 60],
      "read:account": [1200, 60],
      write: [300, 60],
      "write:account": [120, 60],
      bulk: [20, 3600],
      "bulk:account": [20, 3600],
      fetch: [120, 60],
      "fetch:account": [60, 60],
      ai: [60, 3600],
      "ai:account": [60, 3600],
      "ai:workspace": [600, 3600],
      public: [300, 60],
    };
    for (const [name, [count, seconds]] of Object.entries(expected)) {
      expect(registry.window(name), name).toEqual({ capacity: count, refillPerSecond: count / seconds });
    }
  });

  it("override a limit with a count per second, minute or hour", () => {
    const { config } = loadConfig("server", productionEnv({ RATE_LIMIT_PUBLIC_IP: "7/sec", RATE_LIMIT_READ_ACCOUNT: "90/min", RATE_LIMIT_BULK_ACCOUNT: "2/hour" }));
    const registry = createRateLimitRegistry(config);
    expect(registry.window("public")).toEqual({ capacity: 7, refillPerSecond: 7 });
    expect(registry.window("read:account")).toEqual({ capacity: 90, refillPerSecond: 1.5 });
    expect(registry.window("bulk:account")).toEqual({ capacity: 2, refillPerSecond: 2 / 3600 });
    expect(registry.window("read")).toEqual({ capacity: 1200, refillPerSecond: 20 });
  });

  it("treat an empty value as unset", () => {
    const { config } = loadConfig("server", productionEnv({ RATE_LIMIT_PUBLIC_IP: "" }));
    expect(createRateLimitRegistry(config).window("public")).toEqual({ capacity: 300, refillPerSecond: 5 });
  });

  it.each(["0/min", "10", "10/day", "ten/min", "-1/min", "10/ min", "1.5/min", "99999999/min"])("refuse %s, naming the key and not the value", (value) => {
    let error: unknown;
    try {
      loadConfig("server", productionEnv({ RATE_LIMIT_PUBLIC_IP: value }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((issue) => issue.key)).toEqual(["RATE_LIMIT_PUBLIC_IP"]);
    expect((error as ConfigError).message).not.toContain(value);
  });
});
