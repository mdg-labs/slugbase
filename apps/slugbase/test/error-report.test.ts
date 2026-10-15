import { randomBytes } from "node:crypto";
import { defineOperation, emptyResponse, problemResponse } from "@slugbase/contracts";
import type { TenantResolver } from "@slugbase/core";
import type { Database } from "@slugbase/db";
import { createServer, loadConfig, type Logger, type ServerModule } from "@slugbase/server";
import { afterEach, describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";
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
  logLines.length = 0;
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

function configWith(extra: Record<string, string>) {
  return loadConfig("server", {
    NODE_ENV: "production",
    APP_ORIGIN: "https://bookmarks.example.com",
    DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
    DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY_ID: "k1",
    MIGRATE_ON_START: "false",
    ...extra,
  }).config;
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
        authenticate: () => Promise.resolve({ kind: "api-token", accountId: TOKEN_ACCOUNT, workspaceId: TOKEN_WORKSPACE, scope: "read-write" }),
      },
    ],
  }),
};
const tenantResolver: TenantResolver = {
  available: true,
  resolve: () => Promise.resolve({ workspaceId: TOKEN_WORKSPACE, memberId: TOKEN_ACCOUNT, role: "member" }),
};

function serverWith(extra: Record<string, string>, failure: (body: string) => Error) {
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
    adapters: { ...composeAdapters(config, logger), tenantResolver },
    modules: [module, acceptAnyBearer],
    openApiDocument: document,
    migrations: [],
    logger,
    database,
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
