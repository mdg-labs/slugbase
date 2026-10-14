import { loadOpenApiDocument } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { RATE_LIMIT_BUCKETS, RATE_LIMIT_DEFAULTS, RATE_LIMIT_SCOPES, rateLimitKey } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { seedAccount, storeFor } from "../auth/support.ts";
import { readOperations, type DocumentedOperation } from "../contract/document.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// The `http/cross-site` suite (doc 08 section 3.5, doc 04 section 5, Q5, doc 10
// T5), driven by the committed openapi.json: every POST, PUT, PATCH and DELETE
// it declares is sent the requests a browser on another site can make, and must
// answer each with 403 cross_site_request; an operation added to the contract is
// covered by the next run with no edit here. No operation is exempt by name. The
// only operations that skip the rule are those whose contract declares an
// audience (`machine`, `marketing-form`), and they are checked by the rule of
// their audience, not left out.
//
// The requests carry a live session cookie of a real account, so a refusal that
// came too late would show as a session that ended or a state that changed; the
// session is checked at the end of every group. A request the rule lets through
// is not held to its business outcome: it is held to not being the cross-site
// refusal and to an answer the operation declares, which is 401 for an
// operation that needs a credential (the request carries none the rule accepts)
// and a declared status for an anonymous one, whose empty body the validation
// stage may refuse.

const HOOK_TIMEOUT_MS = 300_000;
const PATH_PARAMETER = "0192f3a0-cccc-7000-8000-000000000001";
const MUTATING = new Set(["post", "put", "patch", "delete"]);
const WITH_BODY = new Set(["post", "put", "patch"]);

const database = useTestDatabase();
const committed = loadOpenApiDocument();
const origin = serverConfig({ NODE_ENV: "test" }).APP_ORIGIN;
const operations = readOperations(committed).operations;

function audienceOf(operation: DocumentedOperation): unknown {
  return operation.entry["x-slugbase-audience"];
}

const mutations = operations.filter((operation) => MUTATING.has(operation.method));
const browserMutations = mutations.filter((operation) => audienceOf(operation) === undefined);
const audienceMutations = mutations.filter((operation) => audienceOf(operation) !== undefined);
const credentialed = operations.filter((operation) => audienceOf(operation) === undefined && operation.auth !== "anonymous");

let server: Server;
let store: AuthStore;
let cookie: string;
const answered: { readonly subject: string; readonly headers: Headers }[] = [];

beforeAll(async () => {
  const limits = Object.fromEntries(
    RATE_LIMIT_BUCKETS.flatMap((bucket) =>
      RATE_LIMIT_SCOPES.filter((scope) => scope in RATE_LIMIT_DEFAULTS[bucket]).map((scope) => [rateLimitKey(bucket, scope), "1000000/min"] as const),
    ),
  );
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), ...limits });
  store = storeFor(database());
  server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    authStore: store,
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
  });
  const account = await seedAccount(database());
  const response = await server.fetch(
    new Request(new URL("/api/v1/auth/login", origin), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password, remember: false }),
    }),
  );
  const session = /^(__Host-slugbase_session=[A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || session === undefined) {
    throw new Error(`the suite could not sign in: ${String(response.status)}`);
  }
  cookie = session;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

interface Attempt {
  /** The `Origin` header; `null` sends none. Defaults to the app's origin. */
  readonly origin?: string | null;
  /** The `Content-Type` header; `null` sends none. Defaults to JSON. */
  readonly contentType?: string | null;
  readonly fetchSite?: string;
  readonly authorization?: string;
  /** Whether the live session cookie goes along. Defaults to yes. */
  readonly cookie?: boolean;
  /** Whether the request carries a body (never for a DELETE). Defaults to yes. */
  readonly body?: boolean;
}

function pathOf(operation: DocumentedOperation): string {
  return operation.path.replace(/\{[^}]+\}/g, PATH_PARAMETER);
}

function requestFor(operation: DocumentedOperation, attempt: Attempt = {}): Request {
  const headers = new Headers();
  const sentOrigin = attempt.origin === undefined ? origin : attempt.origin;
  if (sentOrigin !== null) {
    headers.set("origin", sentOrigin);
  }
  const contentType = attempt.contentType === undefined ? "application/json" : attempt.contentType;
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }
  if (attempt.fetchSite !== undefined) {
    headers.set("sec-fetch-site", attempt.fetchSite);
  }
  if (attempt.authorization !== undefined) {
    headers.set("authorization", attempt.authorization);
  }
  if (attempt.cookie !== false) {
    headers.set("cookie", cookie);
  }
  const carriesBody = attempt.body !== false && WITH_BODY.has(operation.method);
  return new Request(new URL(pathOf(operation), origin), {
    method: operation.method.toUpperCase(),
    headers,
    ...(carriesBody ? { body: "{}" } : {}),
  });
}

/** Sends a request and records its headers: no answer of the API may ever carry a CORS header. */
async function send(subject: string, request: Request): Promise<Response> {
  const response = await server.fetch(request);
  answered.push({ subject, headers: response.headers });
  expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-")), `CORS headers on ${subject}`).toEqual([]);
  return response;
}

interface Answer {
  readonly status: number;
  readonly code: string | undefined;
}

async function answerOf(operation: DocumentedOperation, attempt: Attempt): Promise<Answer> {
  const response = await send(`${operation.method.toUpperCase()} ${operation.path}`, requestFor(operation, attempt));
  const text = await response.text();
  let code: string | undefined;
  try {
    const body: unknown = JSON.parse(text);
    code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : undefined;
  } catch {
    code = undefined;
  }
  if (code === "cross_site_request") {
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  }
  return { status: response.status, code };
}

function expectRefused(answer: Answer): void {
  expect(answer).toEqual({ status: 403, code: "cross_site_request" });
}

function declaredStatuses(operation: DocumentedOperation): number[] {
  const responses = operation.entry["responses"];
  return typeof responses === "object" && responses !== null ? Object.keys(responses).map(Number) : [];
}

/** What a request the rule lets through is held to: not the refusal, and an answer the operation declares. */
function expectPassesTheRule(operation: DocumentedOperation, answer: Answer): void {
  expect(answer.code).not.toBe("cross_site_request");
  expect(declaredStatuses(operation), `${String(answer.status)} for ${operation.operationId}`).toContain(answer.status);
}

/** The session of the suite still works: nothing a refused request carried was acted on. */
async function expectSessionIntact(): Promise<void> {
  const response = await send("GET /api/v1/me", new Request(new URL("/api/v1/me", origin), { headers: { cookie } }));
  expect(response.status).toBe(200);
}

function foreignOrigins(): Record<string, string> {
  const app = new URL(origin);
  const other = app.protocol === "https:" ? "http:" : "https:";
  return {
    "another site": "https://evil.example",
    "the literal null of a sandboxed frame": "null",
    "the app's host over the other scheme": `${other}//${app.host}`,
    "the app's host on another port": `${app.protocol}//${app.hostname}:8443`,
    "a subdomain of the app": `${app.protocol}//www.${app.host}`,
    "a host that begins with the app's": `${app.protocol}//${app.host}.evil.example`,
    "a host that ends with the app's": `${app.protocol}//evil-${app.host}`,
    "the app's origin with a path": `${app.origin}/`,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  "text/plain": "text/plain",
  "a urlencoded form": "application/x-www-form-urlencoded",
  "a multipart form": "multipart/form-data; boundary=x",
  "a JSON lookalike": "application/vnd.api+json",
  "JSON in the wrong place": "text/plain; charset=application/json",
  "a type that only starts with JSON": "application/jsonx",
};

describe("the document under test", () => {
  it("declares mutating operations, each walked below", () => {
    expect(readOperations(committed).failures).toEqual([]);
    expect(mutations.length).toBeGreaterThan(0);
    expect(browserMutations.length + audienceMutations.length).toBe(mutations.length);
  });
});

describe.each(browserMutations.map((operation) => [`${operation.method.toUpperCase()} ${operation.path}`, operation] as const))(
  "%s",
  (_name, operation) => {
    it("refuses a request without an Origin header", async () => {
      expectRefused(await answerOf(operation, { origin: null }));
      expectRefused(await answerOf(operation, { origin: null, cookie: false }));
    });

    it.each(Object.entries(foreignOrigins()))("refuses an Origin of %s", async (_label, foreign) => {
      expectRefused(await answerOf(operation, { origin: foreign }));
      expectRefused(await answerOf(operation, { origin: foreign, cookie: false }));
    });

    it.each(["cross-site", "same-site", "none"])("refuses Sec-Fetch-Site: %s on a request that names the app's origin", async (site) => {
      expectRefused(await answerOf(operation, { fetchSite: site }));
      expectRefused(await answerOf(operation, { fetchSite: site, cookie: false }));
    });

    it("refuses a cross-site fetch that also names a foreign Origin", async () => {
      expectRefused(await answerOf(operation, { origin: "https://evil.example", fetchSite: "cross-site" }));
    });

    it.each(Object.entries(CONTENT_TYPES))("refuses a body sent as %s", async (_label, contentType) => {
      expectRefused(await answerOf(operation, { contentType }));
      expectRefused(await answerOf(operation, { contentType, cookie: false }));
    });

    it("refuses a request with no content type", async () => {
      expectRefused(await answerOf(operation, { contentType: null, body: false }));
      expectRefused(await answerOf(operation, { contentType: null, body: false, cookie: false }));
    });

    it("refuses a non-bearer Authorization header as it refuses a request without one, and drops the cookie", async () => {
      expectRefused(await answerOf(operation, { origin: null, authorization: "Basic dXNlcjpwYXNz" }));
      expectRefused(await answerOf(operation, { origin: "https://evil.example", authorization: "Basic dXNlcjpwYXNz" }));
    });

    it("lets the same-origin JSON request through the rule", async () => {
      const anonymous = await answerOf(operation, { cookie: false });
      expectPassesTheRule(operation, anonymous);
      if (operation.auth !== "anonymous") {
        expect(anonymous).toEqual({ status: 401, code: "unauthenticated" });
      }
      expectPassesTheRule(operation, await answerOf(operation, { fetchSite: "same-origin", cookie: false }));
    });
  },
);

describe("the session is untouched by everything refused above", () => {
  it("still resolves the cookie that rode along with every cross-site request", async () => {
    await expectSessionIntact();
  });
});

describe("a request that carries a bearer token", () => {
  // No API-token authenticator is composed yet, so no bearer credential is accepted: the request is
  // anonymous, its cookie is dropped, and the rule's origin and fetch-site checks do not apply to it.
  // The token-accepted path is covered once a resolver exists; what is checked here is the part the
  // rule owns (T5, doc 04 section 4.1).
  const BEARER = "Bearer not-a-token";

  describe.each(browserMutations.map((operation) => [`${operation.method.toUpperCase()} ${operation.path}`, operation] as const))(
    "%s",
    (_name, operation) => {
      it("skips the Origin and Sec-Fetch-Site checks", async () => {
        for (const attempt of [
          { origin: null },
          { origin: "https://evil.example" },
          { origin: "https://evil.example", fetchSite: "cross-site" },
          { fetchSite: "cross-site" },
        ] satisfies Attempt[]) {
          const answer = await answerOf(operation, { ...attempt, authorization: BEARER });
          expectPassesTheRule(operation, answer);
          if (operation.auth !== "anonymous") {
            expect(answer).toEqual({ status: 401, code: "unauthenticated" });
          }
        }
      });

      it("ignores the session cookie that comes with it", async () => {
        const answer = await answerOf(operation, { authorization: BEARER });
        expectPassesTheRule(operation, answer);
        if (operation.auth !== "anonymous") {
          expect(answer).toEqual({ status: 401, code: "unauthenticated" });
        }
      });

      if (WITH_BODY.has(operation.method)) {
        it("still has to be JSON, which is held ahead of authentication", async () => {
          const answer = await answerOf(operation, { origin: null, contentType: "text/plain", authorization: BEARER });
          expect(answer).toEqual({ status: 415, code: "unsupported_media_type" });
        });
      }
    },
  );

  describe.each(credentialed.map((operation) => [`${operation.method.toUpperCase()} ${operation.path}`, operation] as const))(
    "%s",
    (_name, operation) => {
      it("is answered as a token request alone: the cookie that would sign it in is not read", async () => {
        const subject = `${operation.method.toUpperCase()} ${operation.path}`;
        const withBoth = await send(subject, requestFor(operation, { origin: null, authorization: BEARER }));
        expect(withBoth.status).toBe(401);
        const bearerAlone = await send(subject, requestFor(operation, { origin: null, authorization: BEARER, cookie: false }));
        expect(bearerAlone.status).toBe(401);
      });
    },
  );

  it("leaves the session as it was", async () => {
    await expectSessionIntact();
  });

});

describe("operations that declare an audience", () => {
  // `machine` and `marketing-form` operations are outside the browser session model by contract. The
  // document holds none yet; when one is added it is held to the rule of its audience here.
  describe.each(audienceMutations.map((operation) => [`${operation.method.toUpperCase()} ${operation.path}`, operation] as const))(
    "%s",
    (_name, operation) => {
      it("never acts on a session cookie, and a marketing form answers only its own origin", async () => {
        const audience = audienceOf(operation);
        expect(["machine", "marketing-form"]).toContain(audience);
        if (audience === "marketing-form") {
          expectRefused(await answerOf(operation, { origin: null }));
          expectRefused(await answerOf(operation, { origin: "https://evil.example" }));
          expectRefused(await answerOf(operation, { contentType: "text/plain" }));
        } else {
          const answer = await answerOf(operation, { origin: "https://evil.example", contentType: "text/plain" });
          expect(answer.code).not.toBe("cross_site_request");
        }
        await expectSessionIntact();
      });
    },
  );
});

describe("CORS", () => {
  it("answers a preflight to every path of the document, and to a path that does not exist, with 403", async () => {
    const paths = new Set([...operations.map(pathOf), "/api/v1/does-not-exist"].filter((path) => path === "/api" || path.startsWith("/api/")));
    expect(paths.size).toBeGreaterThan(0);
    for (const path of paths) {
      for (const preflightOrigin of ["https://evil.example", origin]) {
        const response = await send(
          `OPTIONS ${path}`,
          new Request(new URL(path, origin), {
            method: "OPTIONS",
            headers: {
              origin: preflightOrigin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            },
          }),
        );
        expect(response.status, `preflight to ${path} from ${preflightOrigin}`).toBe(403);
        expect((await response.json()) as { code: string }).toMatchObject({ code: "cross_site_request" });
      }
    }
  });

  it("answers a preflight to /api itself with 403", async () => {
    const response = await send("OPTIONS /api", new Request(new URL("/api", origin), { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(response.status).toBe(403);
  });

  it("emits no Access-Control-* header on any answer, whatever method, Origin or status", async () => {
    for (const operation of operations.filter((candidate) => pathOf(candidate).startsWith("/api"))) {
      for (const sentOrigin of ["https://evil.example", origin, null] as const) {
        await send(
          `${operation.method.toUpperCase()} ${operation.path}`,
          requestFor(operation, { origin: sentOrigin, cookie: false }),
        );
      }
    }
    expect(answered.length).toBeGreaterThan(0);
    for (const { subject, headers } of answered) {
      expect([...headers.keys()].filter((name) => name.startsWith("access-control-")), subject).toEqual([]);
    }
  });
});
