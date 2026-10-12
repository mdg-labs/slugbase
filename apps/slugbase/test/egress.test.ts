import { randomBytes } from "node:crypto";
import { EgressBlocked, type EgressPort } from "@slugbase/core";
import type { Database } from "@slugbase/db";
import { createServer, createWorker, loadConfig, type Logger, type ServerModule } from "@slugbase/server";
import { describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The composition root builds the egress adapter and hands it to the server and the worker as
// `adapters.egress` (doc 01 section 6, T6). A module reads it from the context it is registered with.

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const database: Database = {
  withTenant: (_context, fn) => fn({ accountId: "", workspaceId: undefined, requestId: "" }),
  close: () => Promise.resolve(),
};

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

function capturingModule(seen: EgressPort[]): ServerModule {
  return {
    name: "probe",
    register: (context) => {
      seen.push(context.adapters.egress);
      return {};
    },
  };
}

async function refusal(egress: EgressPort, url: string): Promise<unknown> {
  return egress.request({ url, timeoutMs: 1_000, maxBytes: 10 }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("egress in the composition root", () => {
  it("is available on the adapters of the server and the worker", () => {
    const server = loadConfig("server", environment).config;
    const worker = loadConfig("worker", environment).config;
    expect(composeAdapters(server, logger).egress.available).toBe(true);
    expect(composeAdapters(worker, logger).egress.available).toBe(true);
  });

  it("reaches a module of the server, which refuses the metadata address and the mapped loopback literal", async () => {
    const config = loadConfig("server", environment).config;
    const seen: EgressPort[] = [];
    createServer({
      config,
      adapters: composeAdapters(config, logger),
      modules: [capturingModule(seen)],
      migrations: [],
      logger,
      database,
    });
    const egress = seen[0];
    expect(egress?.available).toBe(true);
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/", "http://localhost/"]) {
      expect(await refusal(egress as EgressPort, url), url).toBeInstanceOf(EgressBlocked);
    }
  });

  it("reaches a module of the worker", () => {
    const config = loadConfig("worker", environment).config;
    const seen: EgressPort[] = [];
    createWorker({ config, adapters: composeAdapters(config, logger), modules: [capturingModule(seen)], logger });
    expect(seen[0]?.available).toBe(true);
  });
});
