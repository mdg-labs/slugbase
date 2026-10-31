import { randomBytes } from "node:crypto";
import { AiSuggestError, EgressBlocked, type AiSuggestRequest, type EgressPort } from "@slugbase/core";
import type { Database } from "@slugbase/db";
import { createServer, createWorker, loadConfig, type Logger, type ServerModule } from "@slugbase/server";
import { afterEach, describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";
import { startHttpSink, type HttpSink } from "./http-sink.ts";

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

// Q90: the AI adapter holds an egress instance of its own, which carries the operator's allowance for the origin of AI_BASE_URL.
// The instance every other caller shares (metadata, favicons, OIDC discovery) is `adapters.egress`, which has none.
describe("the egress instance of the AI adapter", () => {
  const ai = { AI_BASE_URL: "https://api.example.com/v1", AI_API_KEY: "provider-key-qx88-visible", AI_MODEL: "small-model", AI_PROVIDER_NAME: "Example AI" };
  const request: AiSuggestRequest = { url: "https://example.com/", language: "en", tags: [] };
  const sinks: HttpSink[] = [];
  afterEach(async () => {
    await Promise.all(sinks.splice(0).map((sink) => sink.close()));
  });

  // An endpoint on loopback: the sink answers 200 with `{}`, which the adapter refuses as an answer, but it records the request.
  async function endpoint(): Promise<{ sink: HttpSink; env: Record<string, string> }> {
    const sink = await startHttpSink();
    sinks.push(sink);
    return { sink, env: { ...ai, AI_BASE_URL: `http://127.0.0.1:${new URL(sink.dsn).port}/v1` } };
  }

  async function failureOf(work: Promise<unknown>): Promise<unknown> {
    return work.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("refuses an endpoint on a private address when the operator names no host: no connection is made", async () => {
    const { sink, env } = await endpoint();
    const adapters = composeAdapters(loadConfig("server", { ...environment, ...env }).config, logger);
    const error = await failureOf(adapters.ai.suggest(request));
    expect(error).toBeInstanceOf(AiSuggestError);
    expect((error as AiSuggestError).cause).toBeInstanceOf(EgressBlocked);
    expect(sink.bodies).toEqual([]);
  });

  it("reaches an endpoint on a private address when the operator names its host, on the AI adapter's instance alone", async () => {
    const { sink, env } = await endpoint();
    const adapters = composeAdapters(loadConfig("server", { ...environment, ...env, AI_ALLOWED_PRIVATE_HOST: "127.0.0.1" }).config, logger);

    const error = await failureOf(adapters.ai.suggest(request));
    expect(error).toMatchObject({ code: "ai_invalid_response" });
    expect(sink.bodies).toHaveLength(1);
    expect(sink.bodies[0]).toContain('"model":"small-model"');

    // The shared egress port, which the metadata, favicon and OIDC discovery callers use, has no allowance.
    const shared = await failureOf(adapters.egress.request({ url: env["AI_BASE_URL"] as string, timeoutMs: 1_000, maxBytes: 100 }));
    expect(shared).toBeInstanceOf(EgressBlocked);
    expect(sink.bodies).toHaveLength(1);
  });

  it("keeps the allowance to the one origin: the metadata address stays refused for the AI adapter", async () => {
    const config = loadConfig("server", {
      ...environment,
      ...ai,
      AI_BASE_URL: "http://169.254.169.254/v1",
      AI_ALLOWED_PRIVATE_HOST: "169.254.169.254",
    }).config;
    const error = await failureOf(composeAdapters(config, logger).ai.suggest(request));
    expect((error as AiSuggestError).cause).toBeInstanceOf(EgressBlocked);
  });
});
