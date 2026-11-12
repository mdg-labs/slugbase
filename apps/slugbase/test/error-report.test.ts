import { randomBytes } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { defineOperation, emptyResponse, problemResponse } from "@slugbase/contracts";
import type { TenantResolver } from "@slugbase/core";
import type { Database } from "@slugbase/db";
import { createServer, loadConfig, type Logger, type ServerModule } from "@slugbase/server";
import { afterEach, describe, expect, it } from "vitest";
import { composeAdapters, composeWithWorkerAdapters } from "../src/main.ts";
import { startHttpSink, type HttpSink } from "./http-sink.ts";

// The composition root selects the error-report adapter from ERROR_REPORT_DSN and
// passes it to the server as `adapters.errors`: an unexpected exception in a route
// reaches the error tracker once, and what reaches it holds no personal data (T7).

const PASSWORD = "seed-password-Zq8-hunter2";
const EMAIL = "member.seed@example.com";
const BEARER = "seedbearerAAAA1111bbbb2222";

const submit = defineOperation({
  method: "post",
  path: "/api/v1/widgets/{id}",
  operationId: "submitWidget",
  tag: "test",
  auth: "anonymous",
  rate: "none",
  responses: {
    204: emptyResponse("none"),
    404: problemResponse("not found"),
  },
});

const document = {
  paths: {
    [submit.path]: {
      post: { operationId: submit.operationId, "x-slugbase-auth": submit.auth, "x-slugbase-rate": submit.rate },
    },
  },
};

const logLines: string[] = [];
const logger: Logger = {
  info: (message) => logLines.push(message),
  warn: (message) => logLines.push(message),
  error: (message) => logLines.push(message),
};

const database: Database = {
  withTenant: (_context, fn) => fn({ accountId: "", workspaceId: undefined, requestId: "" }),
  close: () => Promise.resolve(),
};

const sinks: HttpSink[] = [];

async function startSink(): Promise<HttpSink> {
  const sink = await startHttpSink();
  sinks.push(sink);
  return sink;
}

afterEach(async () => {
  trace.disable();
  logLines.length = 0;
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

function environmentWith(extra: Record<string, string>): Record<string, string> {
  return {
    NODE_ENV: "production",
    APP_ORIGIN: "https://bookmarks.example.com",
    DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
    DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY_ID: "k1",
    MIGRATE_ON_START: "false",
    ...extra,
  };
}

function configWith(extra: Record<string, string>) {
  return loadConfig("server", environmentWith(extra)).config;
}

// The bearer credential is not under test: the stub accepts every Authorization header as a token of one account,
// so the request reaches the failing route and the report can be checked for the value it carried.
const TOKEN_ACCOUNT = "0190a000-0000-7000-8000-0000000000b1";
const TOKEN_WORKSPACE = "0190a000-0000-7000-8000-000000000001";
const acceptAnyBearer: ServerModule = {
  name: "accept-any-bearer",
  register: () => ({
    routes: [],
    authenticators: [
      {
        credential: "bearer",
        authenticate: () => Promise.resolve({ kind: "api-token", tokenId: "stub-token", accountId: TOKEN_ACCOUNT, workspaceId: TOKEN_WORKSPACE, scope: "read-write" }),
      },
    ],
  }),
};
const tenantResolver: TenantResolver = {
  available: true,
  resolve: () => Promise.resolve({ workspaceId: TOKEN_WORKSPACE, memberId: TOKEN_ACCOUNT, role: "member" }),
};

function serverWith(extra: Record<string, string>, failure: (body: string) => Error, process?: "server" | "worker") {
  const config = configWith(extra);
  const module: ServerModule = {
    name: "widgets",
    register: () => ({
      routes: [
        {
          operation: submit,
          handler: async (context) => {
            throw failure(await context.req.text());
          },
        },
      ],
    }),
  };
  return createServer({
    config,
    adapters: { ...composeAdapters(config, logger, {}, process === undefined ? {} : { process }), tenantResolver },
    modules: [module, acceptAnyBearer],
    openApiDocument: document,
    migrations: [],
    logger,
    database,
    // The stub credential names an account the database knows nothing of, so none has a mode to read: it has full access.
    accessMode: { accountAccessMode: () => Promise.resolve({ mode: "full" as const }) },
  });
}

function post(server: ReturnType<typeof serverWith>, body: string) {
  return server.fetch(
    new Request("https://bookmarks.example.com/api/v1/widgets/7?token=seed-query-token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://bookmarks.example.com",
        cookie: "sb_session=seedcookieCCCC3333dddd",
        authorization: `Bearer ${BEARER}`,
        "x-forwarded-for": "203.0.113.77",
      },
      body,
    }),
  );
}

async function settled(sink: HttpSink): Promise<void> {
  const deadline = Date.now() + 5000;
  while (sink.bodies.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe("error reporting in the composition root", () => {
  it("uses the no-op adapter without ERROR_REPORT_DSN, and logs the failure only", async () => {
    const config = configWith({});
    expect(composeAdapters(config, logger).errors.available).toBe(false);
    const server = serverWith({}, (body) => new Error(`failed on ${body}`));
    const response = await post(server, JSON.stringify({ password: PASSWORD }));
    expect(response.status).toBe(500);
    expect(logLines).toContain("Request failed");
    expect(logLines).toContain("Error reporting is off; errors are only logged");
  });

  it("sends exactly one scrubbed report for an unexpected exception in a route, and still answers 500", async () => {
    const sink = await startSink();
    const server = serverWith({ ERROR_REPORT_DSN: sink.dsn }, (body) => new Error(`cannot process ${body} for ${EMAIL}`));

    const response = await post(server, JSON.stringify({ email: EMAIL, password: PASSWORD }));
    await settled(sink);

    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe("internal");
    expect(sink.bodies).toHaveLength(1);
    const envelope = sink.bodies[0] ?? "";
    for (const secret of [PASSWORD, EMAIL, BEARER, "seedcookieCCCC3333dddd", "203.0.113.77", "seed-query-token", "seedpublickey"]) {
      expect(envelope).not.toContain(secret);
    }
    expect(envelope).toContain("cannot process");
    expect(envelope).toContain('"transaction":"POST /api/v1/widgets/{id}"');
    expect(logLines).toContain("Error reporting ready");
    expect(logLines.join("\n")).not.toContain(sink.dsn);
  });

  it("does not report a failure that is the caller's, only the unexpected one", async () => {
    const sink = await startSink();
    const server = serverWith({ ERROR_REPORT_DSN: sink.dsn }, () => new Error("unused"));
    const response = await server.fetch(new Request("https://bookmarks.example.com/api/v1/nothing"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(response.status).toBe(404);
    expect(sink.bodies).toHaveLength(0);
  });
});

interface EnvelopeItem {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function itemsOf(sink: HttpSink): EnvelopeItem[] {
  return sink.bodies.flatMap((body) => {
    const lines = body.split("\n").filter((line) => line !== "");
    const items: EnvelopeItem[] = [];
    for (let at = 1; at + 1 < lines.length; at += 2) {
      items.push({
        type: (JSON.parse(lines[at] ?? "{}") as { type: string }).type,
        payload: JSON.parse(lines[at + 1] ?? "{}") as Record<string, unknown>,
      });
    }
    return items;
  });
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("tags, traces and check-ins in the composition root", () => {
  it("tags the reports of each process with it", async () => {
    const sink = await startSink();
    for (const process of ["server", "worker"] as const) {
      const config = loadConfig(process, environmentWith({ ERROR_REPORT_DSN: sink.dsn })).config;
      await composeAdapters(config, logger, {}, { process }).errors.capture(new Error(`from the ${process}`));
    }

    expect(itemsOf(sink).map((item) => item.payload["tags"])).toEqual([{ process: "server" }, { process: "worker" }]);
  });

  it("sends nothing but the errors while traces and check-ins are unset", async () => {
    const sink = await startSink();
    const server = serverWith({ ERROR_REPORT_DSN: sink.dsn }, () => new Error("boom"), "server");

    await post(server, JSON.stringify({ email: EMAIL }));
    await settled(sink);

    expect(itemsOf(sink).map((item) => item.type)).toEqual(["event"]);
    const adapters = composeAdapters(loadConfig("worker", environmentWith({ ERROR_REPORT_DSN: sink.dsn })).config, logger, {}, { process: "worker" });
    expect("startMonitoredRun" in adapters.errors).toBe(false);
  });

  it("sends a sampled request as a transaction named by its route template, with no personal data in what leaves the process", async () => {
    const sink = await startSink();
    const server = serverWith({ ERROR_REPORT_DSN: sink.dsn, ERROR_REPORT_TRACES_SAMPLE_RATE: "1" }, (body) => new Error(`cannot process ${body}`), "server");

    const response = await post(server, JSON.stringify({ email: EMAIL, password: PASSWORD }));
    await until(() => itemsOf(sink).some((item) => item.type === "transaction"), "the transaction");
    await settled(sink);

    expect(response.status).toBe(500);
    for (const body of sink.bodies) {
      for (const secret of [PASSWORD, EMAIL, BEARER, "seedcookieCCCC3333dddd", "203.0.113.77", "seed-query-token", "seedpublickey"]) {
        expect(body).not.toContain(secret);
      }
    }
    const transactions = itemsOf(sink).filter((item) => item.type === "transaction");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.payload).toMatchObject({
      transaction: "POST /api/v1/widgets/{id}",
      environment: "production",
      tags: { process: "server" },
      contexts: { trace: { op: "http.server", status: "internal_error", data: { "http.route": "/api/v1/widgets/{id}" } } },
    });
  });

  it("registers no tracer provider in the worker, whatever the rate", () => {
    const config = loadConfig("worker", environmentWith({ ERROR_REPORT_DSN: "https://publickey@errors.example.com/1", ERROR_REPORT_TRACES_SAMPLE_RATE: "1" })).config;
    composeAdapters(config, logger, {}, { process: "worker" });

    expect(trace.getTracer("probe").startSpan("GET /").isRecording()).toBe(false);
  });

  it("composes the server and the worker of one process, with the trace provider the server's alone", async () => {
    const sink = await startSink();
    const extra = { ERROR_REPORT_DSN: sink.dsn, ERROR_REPORT_TRACES_SAMPLE_RATE: "1", ERROR_REPORT_CHECK_INS: "true" };
    const serverConfig = loadConfig("server", environmentWith(extra)).config;
    const workerConfig = loadConfig("worker", environmentWith(extra)).config;

    const adapters = composeWithWorkerAdapters(serverConfig, workerConfig, logger);

    expect(trace.getTracer("probe").startSpan("GET /").isRecording()).toBe(true);
    await adapters.server.errors.capture(new Error("server"));
    await adapters.worker.errors.capture(new Error("worker"));
    expect(itemsOf(sink).map((item) => item.payload["tags"])).toEqual([{ process: "server" }, { process: "worker" }]);
    expect("startMonitoredRun" in adapters.worker.errors).toBe(true);
  });

  it("sends the check-ins of a scheduled job when the worker is configured for them, with the environment", async () => {
    const sink = await startSink();
    const config = loadConfig("worker", environmentWith({ ERROR_REPORT_DSN: sink.dsn, ERROR_REPORT_CHECK_INS: "true" })).config;
    const { errors } = composeAdapters(config, logger, {}, { process: "worker" });

    const run = await errors.startMonitoredRun?.("retention-purge");
    await run?.finish("error");

    const checkIns = itemsOf(sink).filter((item) => item.type === "check_in");
    expect(checkIns.map((item) => item.payload["status"])).toEqual(["in_progress", "error"]);
    expect(checkIns[1]?.payload).toMatchObject({ monitor_slug: "retention-purge", environment: "production" });
  });
});
