import {
  RATE_BUCKETS,
  defineOperation,
  jsonResponse,
  problemResponse,
  type AuthPolicy,
  type OperationDefinition,
  type RateBucket,
} from "@slugbase/contracts";
import { PortUnavailable, unconfigured, type ErrorReportPort, type RateLimitPort } from "@slugbase/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RATE_LIMIT_BUCKETS, createRateLimitRegistry } from "../../src/config/index.ts";
import { createAuthentication, type Authenticator } from "../../src/http/authenticate.ts";
import { RouteTable, installChain, type ChainEnv, type RouteBinding, type StageImplementations } from "../../src/http/chain.ts";
import { ProblemError } from "../../src/http/problem.ts";
import { hookDispatcher, recordingLogger, serverConfig, tenantDependencies } from "../support.ts";
import { memoryRateLimiter } from "./rate-limit-support.ts";

// Stages 3a and 6 of the chain (doc 01 section 4, doc 04 section 7, doc 10 T9),
// exercised through the chain with an in-memory limiter that does the
// arithmetic of the Postgres adapter. The Postgres adapter and a real socket
// are in the composition's integration test.

const Echo = z.record(z.string(), z.unknown());

function limited(path: string, id: string, rate: RateBucket, options: { audience?: "machine"; auth?: AuthPolicy } = {}): OperationDefinition {
  return defineOperation({
    method: "get",
    path,
    operationId: id,
    tag: "test",
    auth: options.auth ?? "anonymous",
    rate,
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    responses: { 200: jsonResponse("ok", Echo), 404: problemResponse("not found") },
  });
}

const ok = (): Response => Response.json({ ok: true });

const route = (operation: OperationDefinition, handler: RouteBinding["handler"] = ok): RouteBinding => ({ operation, handler });

interface Build {
  readonly env?: Record<string, string>;
  readonly hops?: number;
  readonly limiter?: (registry: ReturnType<typeof createRateLimitRegistry>) => RateLimitPort;
  readonly errors?: ErrorReportPort;
  readonly stages?: StageImplementations;
}

function build(bindings: readonly RouteBinding[], options: Build = {}) {
  const config = serverConfig(options.env);
  const rateLimits = createRateLimitRegistry(config);
  const memory = memoryRateLimiter(rateLimits);
  const logger = recordingLogger();
  const rejections: string[] = [];
  const app = new Hono<ChainEnv>();
  installChain(
    app,
    {
      logger,
      routes: new RouteTable(bindings),
      trustedProxyHops: options.hops ?? 0,
      appOrigin: "https://bookmarks.example.com",
      challenge: unconfigured().challenge,
      errors: options.errors ?? unconfigured().errors,
      ...tenantDependencies(),
      rateLimit: options.limiter?.(rateLimits) ?? memory,
      rateLimits,
      hooks: hookDispatcher(),
      responseValidation: "throw",
      metrics: {
        recordRequest: () => undefined,
        recordRateLimitRejection: (bucket) => {
          rejections.push(bucket);
        },
      },
    },
    {
      // A stub authenticator: the account is named by a header.
      authentication: async (context, next) => {
        const accountId = context.req.header("x-account");
        if (accountId !== undefined) {
          context.set("principal", { kind: "session", sessionId: "stub-session", accountId, activeWorkspaceId: context.req.header("x-workspace"), instanceAdmin: false });
        }
        return next();
      },
      // The tenant is not under test: the stub principal has no workspace to resolve.
      "tenant-resolution": (_context, next) => next(),
      ...options.stages,
    },
  );
  const get = (path: string, headers: Record<string, string> = {}): Promise<Response> => Promise.resolve(app.request(path, { headers }));
  return { get, memory, logger, rejections };
}

const PUBLIC = route(limited("/api/v1/open", "open", "public"));
const READ = route(limited("/api/v1/items", "items", "read"));
const READ_AS_ACCOUNT = route(limited("/api/v1/items", "items", "read", { auth: "account" }));

describe("the rate-limit stage", () => {
  it("allows requests up to the burst of the bucket and carries the policy and the remaining tokens", async () => {
    const { get } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "3/min" } });
    const first = await get("/api/v1/open");
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-policy")).toBe('"public";q=3;w=60');
    expect(first.headers.get("ratelimit")).toBe('"public";r=2;t=20');
    expect(first.headers.get("retry-after")).toBeNull();
    expect((await get("/api/v1/open")).headers.get("ratelimit")).toBe('"public";r=1;t=40');
    expect((await get("/api/v1/open")).headers.get("ratelimit")).toBe('"public";r=0;t=60');
  });

  it("refuses the request after the burst with 429 rate_limited, Retry-After and the same headers", async () => {
    const { get, rejections } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "3/min" } });
    for (let taken = 0; taken < 3; taken += 1) {
      expect((await get("/api/v1/open")).status).toBe(200);
    }
    const denied = await get("/api/v1/open");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("content-type")).toContain("application/problem+json");
    expect(denied.headers.get("retry-after")).toBe("20");
    expect(denied.headers.get("ratelimit-policy")).toBe('"public";q=3;w=60');
    expect(denied.headers.get("ratelimit")).toBe('"public";r=0;t=60');
    expect(await denied.json()).toMatchObject({ code: "rate_limited", status: 429 });
    expect(rejections).toEqual(["public"]);
  });

  it("answers again once the bucket has refilled", async () => {
    const { get, memory } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "2/min" } });
    await get("/api/v1/open");
    await get("/api/v1/open");
    expect((await get("/api/v1/open")).status).toBe(429);
    memory.advance(30);
    expect((await get("/api/v1/open")).status).toBe(200);
  });

  it("never reaches the handler of a refused request", async () => {
    let handled = 0;
    const counted = route(limited("/api/v1/open", "open", "public"), () => {
      handled += 1;
      return ok();
    });
    const { get } = build([counted], { env: { RATE_LIMIT_PUBLIC_IP: "1/min" } });
    await get("/api/v1/open");
    await get("/api/v1/open");
    expect(handled).toBe(1);
  });

  it("does not limit a bucket declared none, a machine route or a request that matches no operation", async () => {
    const none = route(limited("/api/v1/probe", "probe", "none"));
    const machine = route(limited("/api/v1/hook", "hook", "read", { audience: "machine", auth: "machine" }));
    const { get, memory } = build([none, machine], { env: { RATE_LIMIT_READ_IP: "1/min" } });
    for (let request = 0; request < 5; request += 1) {
      for (const path of ["/api/v1/probe", "/api/v1/hook"]) {
        const response = await get(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("ratelimit")).toBeNull();
      }
      expect((await get("/api/v1/nothing")).status).toBe(404);
    }
    expect(memory.takes).toEqual([]);
  });

  it("keeps a bucket per client IP", async () => {
    const { get } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "2/min" }, hops: 1 });
    const from = (ip: string) => get("/api/v1/open", { "x-forwarded-for": ip });
    await from("203.0.113.1");
    await from("203.0.113.1");
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(200);
  });

  describe("the key of an IP bucket", () => {
    const spend = async (get: (path: string, headers?: Record<string, string>) => Promise<Response>, ip: string): Promise<number> =>
      (await get("/api/v1/open", { "x-forwarded-for": ip })).status;

    it("shares one bucket between the addresses of an IPv6 /64", async () => {
      const { get, memory } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "2/min" }, hops: 1 });
      expect(await spend(get, "2001:db8:1:2::1")).toBe(200);
      expect(await spend(get, "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(200);
      expect(await spend(get, "2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe(429);
      expect(new Set(memory.takes.map((take) => take.key)).size).toBe(1);
    });

    it("keeps a separate bucket for another /64", async () => {
      const { get } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "1/min" }, hops: 1 });
      expect(await spend(get, "2001:db8:1:2::1")).toBe(200);
      expect(await spend(get, "2001:db8:1:2::2")).toBe(429);
      expect(await spend(get, "2001:db8:1:3::1")).toBe(200);
      expect(await spend(get, "2001:db8:2:2::1")).toBe(200);
    });

    it("shares one bucket between an IPv4-mapped IPv6 address and the IPv4 address", async () => {
      const { get, memory } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "1/min" }, hops: 1 });
      expect(await spend(get, "198.51.100.7")).toBe(200);
      expect(await spend(get, "::ffff:198.51.100.7")).toBe(429);
      expect(await spend(get, "::ffff:c633:6407")).toBe(429);
      expect(new Set(memory.takes.map((take) => take.key)).size).toBe(1);
    });

    it("keeps the full address on the request context for logs", async () => {
      let seen: string | undefined;
      const record = route(limited("/api/v1/open", "open", "public"), (context) => {
        seen = context.get("clientIp");
        return ok();
      });
      const { get } = build([record], { hops: 1 });
      await get("/api/v1/open", { "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" });
      expect(seen).toBe("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    });
  });

  it("keeps a bucket per account, and the account bucket empties first when it is the smaller", async () => {
    const { get, memory } = build([READ_AS_ACCOUNT], { env: { RATE_LIMIT_READ_IP: "50/min", RATE_LIMIT_READ_ACCOUNT: "2/min" } });
    const as = (account: string) => get("/api/v1/items", { "x-account": account });
    expect((await as("a")).status).toBe(200);
    expect((await as("a")).status).toBe(200);
    const denied = await as("a");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("ratelimit-policy")).toBe('"read";q=50;w=60, "read:account";q=2;w=60');
    expect(denied.headers.get("ratelimit")).toBe('"read";r=47;t=4, "read:account";r=0;t=60');
    expect((await as("b")).status).toBe(200);
    expect(memory.takes.map((take) => `${take.bucket}=${take.key}`)).toEqual([
      "read=unknown",
      "read:account=a",
      "read=unknown",
      "read:account=a",
      "read=unknown",
      "read:account=a",
      "read=unknown",
      "read:account=b",
    ]);
  });

  it("empties the IP bucket first when it is the smaller, and then takes nothing from the account", async () => {
    const { get, memory } = build([READ_AS_ACCOUNT], { env: { RATE_LIMIT_READ_IP: "1/min", RATE_LIMIT_READ_ACCOUNT: "50/min" } });
    expect((await get("/api/v1/items", { "x-account": "a" })).status).toBe(200);
    const denied = await get("/api/v1/items", { "x-account": "b" });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("ratelimit")).toBe('"read";r=0;t=60');
    expect(memory.takes.map((take) => take.bucket)).toEqual(["read", "read:account", "read"]);
  });

  it("limits an anonymous request by IP alone", async () => {
    const { get, memory } = build([READ]);
    await get("/api/v1/items");
    expect(memory.takes.map((take) => take.bucket)).toEqual(["read"]);
  });

  it("limits an anonymous operation by IP alone, whatever credential the request carries", async () => {
    const anonymous = route(limited("/api/v1/redeem", "redeem", "read"));
    const { get, memory } = build([anonymous]);
    await get("/api/v1/redeem", { "x-account": "a" });
    expect(memory.takes.map((take) => take.bucket)).toEqual(["read"]);
  });

  it("keeps the buckets independent: emptying one leaves another untouched", async () => {
    const { get } = build([PUBLIC, READ], { env: { RATE_LIMIT_PUBLIC_IP: "1/min" } });
    await get("/api/v1/open");
    expect((await get("/api/v1/open")).status).toBe(429);
    expect((await get("/api/v1/items")).status).toBe(200);
  });

  it("takes the workspace bucket of a bucket that has one, and not the e-mail bucket of one that has that", async () => {
    const ai = route(limited("/api/v1/suggest", "suggest", "ai", { auth: "member" }));
    const login = route(limited("/api/v1/login", "login", "login"));
    const { get, memory } = build([ai, login]);
    await get("/api/v1/suggest", { "x-account": "a", "x-workspace": "w" });
    await get("/api/v1/login", { "x-account": "a" });
    expect(memory.takes).toEqual([
      { bucket: "ai", key: "unknown" },
      { bucket: "ai:account", key: "a" },
      { bucket: "ai:workspace", key: "w" },
      { bucket: "login", key: "unknown" },
    ]);
  });

  describe("the per-address limit an operation takes itself", () => {
    // The stage cannot know the address a login names; its handler takes the limit through the context.
    const attempt = (key: string): RouteBinding["handler"] => async (context) => {
      const take = context.get("takeEmailLimit");
      if (take === undefined) {
        throw new Error("the stage did not offer the per-address limit");
      }
      await take(context, key);
      return Response.json({ ok: true });
    };
    const login = (key = "address-1") => route(limited("/api/v1/login", "login", "login"), attempt(key));

    it("takes the email limit of the bucket under the key the handler gives, after the IP limit", async () => {
      const { get, memory } = build([login("address-1")]);
      expect((await get("/api/v1/login")).status).toBe(200);
      expect(memory.takes).toEqual([
        { bucket: "login", key: "unknown" },
        { bucket: "login:email", key: "address-1" },
      ]);
    });

    it("answers 429 rate_limited with Retry-After and both policies once the address has used its limit", async () => {
      const { get, rejections } = build([login()], { env: { RATE_LIMIT_LOGIN_EMAIL: "2/hour" } });
      expect((await get("/api/v1/login")).status).toBe(200);
      expect((await get("/api/v1/login")).status).toBe(200);
      const denied = await get("/api/v1/login");
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "rate_limited", status: 429 });
      expect(denied.headers.get("retry-after")).toBe("1800");
      expect(denied.headers.get("ratelimit-policy")).toBe('"login";q=10;w=60, "login:email";q=2;w=3600');
      expect(rejections).toEqual(["login"]);
    });

    it("counts each address on its own", async () => {
      const { get } = build([route(limited("/api/v1/login", "login", "login"), async (context) => {
        const take = context.get("takeEmailLimit");
        await take?.(context, context.req.header("x-address") ?? "none");
        return Response.json({ ok: true });
      })], { env: { RATE_LIMIT_LOGIN_EMAIL: "1/hour" } });
      expect((await get("/api/v1/login", { "x-address": "a" })).status).toBe(200);
      expect((await get("/api/v1/login", { "x-address": "b" })).status).toBe(200);
      expect((await get("/api/v1/login", { "x-address": "a" })).status).toBe(429);
    });

    it("answers 503 and does not run the rest of the handler when the limiter fails", async () => {
      let past = 0;
      const failing: RateLimitPort = { available: true, consume: (request) => (request.bucket === "login:email" ? Promise.reject(new Error("store down")) : Promise.resolve({ allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 0 })) };
      const { get } = build(
        [route(limited("/api/v1/login", "login", "login"), async (context) => {
          await context.get("takeEmailLimit")?.(context, "a");
          past += 1;
          return Response.json({ ok: true });
        })],
        { limiter: () => failing },
      );
      const response = await get("/api/v1/login");
      expect(response.status).toBe(503);
      expect(past).toBe(0);
    });

    it("is not offered on a route the stage did not limit", async () => {
      let offered: unknown = "unset";
      const { get } = build([route(limited("/api/v1/open", "open", "none"), (context) => {
        offered = context.get("takeEmailLimit");
        return Response.json({ ok: true });
      })]);
      await get("/api/v1/open");
      expect(offered).toBeUndefined();
    });

    it("fails closed when the operation's bucket has no email limit", async () => {
      const { get } = build([route(limited("/api/v1/open", "open", "public"), async (context) => {
        await context.get("takeEmailLimit")?.(context, "a");
        return Response.json({ ok: true });
      })]);
      expect((await get("/api/v1/open")).status).toBe(503);
    });
  });

  describe("the per-account limit an anonymous operation takes itself", () => {
    // The stage takes no account bucket for an anonymous operation, whatever credential the request carries; the handler of one
    // that finds a session takes it through the context.
    const redeem = route(limited("/api/v1/redeem", "redeem", "token_redeem"), async (context) => {
      const principal = context.get("principal");
      if (principal !== undefined) {
        await context.get("takeAccountLimit")?.(context, principal.accountId);
      }
      return Response.json({ ok: true });
    });

    it("takes the address limit in the stage and the account limit only where the handler asks, under the account's identifier", async () => {
      const { get, memory } = build([redeem]);

      expect((await get("/api/v1/redeem")).status).toBe(200);
      expect((await get("/api/v1/redeem", { "x-account": "a" })).status).toBe(200);

      expect(memory.takes).toEqual([
        { bucket: "token_redeem", key: "unknown" },
        { bucket: "token_redeem", key: "unknown" },
        { bucket: "token_redeem:account", key: "a" },
      ]);
    });

    it("answers 429 rate_limited with Retry-After once the account has used its limit, whatever address the requests come from, and counts another account on its own", async () => {
      const { get, rejections } = build([redeem], { env: { RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "2/hour", RATE_LIMIT_TOKEN_REDEEM_IP: "100/hour" }, hops: 1 });
      const from = (address: string, account: string) => get("/api/v1/redeem", { "x-account": account, "x-forwarded-for": address });

      expect((await from("203.0.113.1", "a")).status).toBe(200);
      expect((await from("203.0.113.2", "a")).status).toBe(200);
      const denied = await from("203.0.113.3", "a");

      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "rate_limited", status: 429 });
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(rejections).toEqual(["token_redeem"]);
      expect((await from("203.0.113.4", "b")).status).toBe(200);
    });

    it("is offered only on a route the stage limited, and fails closed when the bucket has no account limit", async () => {
      let offered: unknown = "unset";
      const unlimited = build([route(limited("/api/v1/open", "open", "none"), (context) => {
        offered = context.get("takeAccountLimit");
        return Response.json({ ok: true });
      })]);
      await unlimited.get("/api/v1/open");
      expect(offered).toBeUndefined();

      const { get } = build([route(limited("/api/v1/open", "open", "public"), async (context) => {
        await context.get("takeAccountLimit")?.(context, "a");
        return Response.json({ ok: true });
      })]);
      expect((await get("/api/v1/open")).status).toBe(503);
    });
  });

  describe("the bucket an operation takes in its handler (rateTakenByHandler)", () => {
    // The favicon operation is in the `fetch` bucket, but only a request that would start a fetch takes from it: the stages limit every request by the `read` bucket, and the
    // handler takes the limits of the declared bucket through the context when it decides the request is such a one.
    const handlerTaken = (): OperationDefinition =>
      defineOperation({
        method: "get",
        path: "/api/v1/things",
        operationId: "things",
        tag: "test",
        auth: "account",
        rate: "fetch",
        rateTakenByHandler: true,
        responses: { 200: jsonResponse("ok", Echo), 404: problemResponse("not found") },
      });
    const taking = (when: (context: Parameters<RouteBinding["handler"]>[0]) => boolean) =>
      route(handlerTaken(), async (context) => {
        if (when(context)) {
          await context.get("takeBucketLimit")?.(context);
        }
        return Response.json({ ok: true });
      });

    it("takes the read bucket in the stages and the declared bucket's address and account limits only where the handler asks", async () => {
      const { get, memory } = build([taking((context) => context.req.header("x-miss") !== undefined)]);

      expect((await get("/api/v1/things", { "x-account": "a" })).status).toBe(200);
      expect(memory.takes).toEqual([
        { bucket: "read", key: "unknown" },
        { bucket: "read:account", key: "a" },
      ]);
      expect((await get("/api/v1/things", { "x-account": "a", "x-miss": "1" })).status).toBe(200);

      expect(memory.takes.slice(2)).toEqual([
        { bucket: "read", key: "unknown" },
        { bucket: "read:account", key: "a" },
        { bucket: "fetch", key: "unknown" },
        { bucket: "fetch:account", key: "a" },
      ]);
    });

    it("answers 429 rate_limited with Retry-After and the RateLimit headers when the handler's take finds the bucket empty, and never for a request that did not ask", async () => {
      const { get, rejections } = build([taking((context) => context.req.header("x-miss") !== undefined)], { env: { RATE_LIMIT_FETCH_ACCOUNT: "2/min", RATE_LIMIT_FETCH_IP: "100/min" } });
      for (let served = 0; served < 5; served += 1) {
        expect((await get("/api/v1/things", { "x-account": "a" })).status).toBe(200);
      }
      expect((await get("/api/v1/things", { "x-account": "a", "x-miss": "1" })).status).toBe(200);
      expect((await get("/api/v1/things", { "x-account": "a", "x-miss": "1" })).status).toBe(200);

      const denied = await get("/api/v1/things", { "x-account": "a", "x-miss": "1" });

      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "rate_limited", status: 429 });
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(denied.headers.get("ratelimit-policy")).toContain('"fetch:account"');
      expect(rejections).toEqual(["fetch"]);
      expect((await get("/api/v1/things", { "x-account": "a" })).status).toBe(200);
      expect((await get("/api/v1/things", { "x-account": "b", "x-miss": "1" })).status).toBe(200);
    });

    it("answers 503 when the limiter cannot decide in the handler's take", async () => {
      const broken: RateLimitPort = { available: true, consume: () => Promise.reject(new Error("the limiter's store is down")) };
      const { get } = build([taking(() => true)], { limiter: () => broken });

      expect((await get("/api/v1/things", { "x-account": "a" })).status).toBe(503);
    });

    it("stops 1000 requests from one IP with random bearer tokens reaching the token lookup after the burst of the read bucket", async () => {
      const lookups = { count: 0 };
      const authenticator: Authenticator = {
        credential: "bearer",
        authenticate: () => {
          lookups.count += 1;
          return Promise.resolve(undefined);
        },
      };
      const guarded = route(
        defineOperation({
          method: "get",
          path: "/api/v1/things",
          operationId: "things",
          tag: "test",
          auth: "member",
          rate: "fetch",
          rateTakenByHandler: true,
          responses: { 200: jsonResponse("ok", Echo), 404: problemResponse("not found") },
        }),
      );
      const { get, rejections } = build([guarded], {
        env: { RATE_LIMIT_READ_IP: "20/min" },
        stages: { authentication: createAuthentication({ authenticators: [authenticator] }) },
      });
      const statuses = new Map<number, number>();
      for (let request = 0; request < 1000; request += 1) {
        const response = await get("/api/v1/things", { authorization: `Bearer slb_${crypto.randomUUID()}` });
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      }
      expect(Object.fromEntries(statuses)).toEqual({ 401: 20, 429: 980 });
      expect(lookups.count).toBe(20);
      expect(new Set(rejections)).toEqual(new Set(["read"]));
    });

    it("is not offered on an operation that does not declare it, whose stages take as always", async () => {
      let offered: unknown = "unset";
      const { get, memory } = build([
        route(limited("/api/v1/items", "items", "read", { auth: "account" }), (context) => {
          offered = context.get("takeBucketLimit");
          return Response.json({ ok: true });
        }),
      ]);

      await get("/api/v1/items", { "x-account": "a" });

      expect(offered).toBeUndefined();
      expect(memory.takes.length).toBeGreaterThan(0);
    });
  });

  describe("before authentication (T9)", () => {
    function rejectingBearer(): { readonly authenticator: Authenticator; readonly lookups: () => number } {
      let lookups = 0;
      return {
        authenticator: {
          credential: "bearer",
          authenticate: () => {
            lookups += 1;
            return Promise.resolve(undefined);
          },
        },
        lookups: () => lookups,
      };
    }

    it("counts a request with a bad bearer token against the IP bucket and answers 429 after the burst, not 401", async () => {
      const { authenticator } = rejectingBearer();
      const { get, rejections } = build([PUBLIC], {
        env: { RATE_LIMIT_PUBLIC_IP: "3/min" },
        stages: { authentication: createAuthentication({ authenticators: [authenticator] }) },
      });
      const bad = (token: string) => get("/api/v1/open", { authorization: `Bearer ${token}` });
      expect((await bad("slb_one")).status).toBe(401);
      expect((await bad("slb_two")).status).toBe(401);
      expect((await bad("slb_three")).status).toBe(401);
      const denied = await bad("slb_four");
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).toBe("20");
      expect(denied.headers.get("ratelimit-policy")).toBe('"public";q=3;w=60');
      expect(denied.headers.get("ratelimit")).toBe('"public";r=0;t=60');
      expect(await denied.json()).toMatchObject({ code: "rate_limited", status: 429 });
      expect(rejections).toEqual(["public"]);
    });

    it("stops 1000 requests from one IP with random bearer tokens reaching the token lookup after the burst", async () => {
      const { authenticator, lookups } = rejectingBearer();
      const { get } = build([PUBLIC], {
        env: { RATE_LIMIT_PUBLIC_IP: "20/min" },
        stages: { authentication: createAuthentication({ authenticators: [authenticator] }) },
      });
      const statuses = new Map<number, number>();
      for (let request = 0; request < 1000; request += 1) {
        const response = await get("/api/v1/open", { authorization: `Bearer slb_${crypto.randomUUID()}` });
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      }
      expect(Object.fromEntries(statuses)).toEqual({ 401: 20, 429: 980 });
      expect(lookups()).toBe(20);
    });

    it.each(["token_create", "bulk", "ai"] as const)(
      "stops 1000 requests from one IP with random bearer tokens reaching the token lookup of a %s route after the burst",
      async (bucket) => {
        const { authenticator, lookups } = rejectingBearer();
        const guarded = route(limited("/api/v1/guarded", "guarded", bucket, { auth: "member" }));
        const { get, rejections } = build([guarded], {
          env: { [`RATE_LIMIT_${bucket.toUpperCase()}_IP`]: "20/hour" },
          stages: { authentication: createAuthentication({ authenticators: [authenticator] }) },
        });
        const statuses = new Map<number, number>();
        for (let request = 0; request < 1000; request += 1) {
          const response = await get("/api/v1/guarded", { authorization: `Bearer slb_${crypto.randomUUID()}` });
          statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        }
        expect(Object.fromEntries(statuses)).toEqual({ 401: 20, 429: 980 });
        expect(lookups()).toBe(20);
        expect(new Set(rejections)).toEqual(new Set([bucket]));
      },
    );

    it("takes the IP bucket before authentication and the account and workspace buckets after it", async () => {
      const trace: string[] = [];
      const { get, memory } = build([READ_AS_ACCOUNT], {
        stages: {
          authentication: async (context, next) => {
            trace.push(`authentication after ${memory.takes.map((take) => take.bucket).join(",") || "nothing"}`);
            context.set("principal", { kind: "session", sessionId: "stub-session", accountId: "a", activeWorkspaceId: undefined, instanceAdmin: false });
            return next();
          },
        },
      });
      await get("/api/v1/items");
      expect(trace).toEqual(["authentication after read"]);
      expect(memory.takes.map((take) => take.bucket)).toEqual(["read", "read:account"]);
    });

    it("does not limit a bucket declared none or a machine route before authentication, and answers 503 when the limiter fails there", async () => {
      const none = route(limited("/api/v1/probe", "probe", "none"));
      const machine = route(limited("/api/v1/hook", "hook", "read", { audience: "machine", auth: "machine" }));
      const unlimited = build([none, machine], { env: { RATE_LIMIT_READ_IP: "1/min" } });
      for (let request = 0; request < 3; request += 1) {
        expect((await unlimited.get("/api/v1/probe")).status).toBe(200);
        expect((await unlimited.get("/api/v1/hook")).status).toBe(200);
      }
      expect(unlimited.memory.takes).toEqual([]);

      const { authenticator, lookups } = rejectingBearer();
      const down = build([PUBLIC], {
        limiter: () => ({ available: true, consume: () => Promise.reject(new Error("down")) }),
        stages: { authentication: createAuthentication({ authenticators: [authenticator] }) },
      });
      const response = await down.get("/api/v1/open", { authorization: "Bearer slb_x" });
      expect(response.status).toBe(503);
      expect(lookups()).toBe(0);
    });
  });

  describe("the client IP (T9)", () => {
    it("does not give a client rotating X-Forwarded-For entries beyond the trusted hops a fresh bucket", async () => {
      const { get } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "3/min" }, hops: 1 });
      const statuses: number[] = [];
      for (let spoof = 1; spoof <= 8; spoof += 1) {
        statuses.push((await get("/api/v1/open", { "x-forwarded-for": `198.51.100.${String(spoof)}, 203.0.113.9` })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    });

    it("ignores X-Forwarded-For altogether without a trusted hop", async () => {
      const { get, memory } = build([PUBLIC], { env: { RATE_LIMIT_PUBLIC_IP: "3/min" }, hops: 0 });
      const statuses: number[] = [];
      for (let spoof = 1; spoof <= 5; spoof += 1) {
        statuses.push((await get("/api/v1/open", { "x-forwarded-for": `198.51.100.${String(spoof)}` })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect(new Set(memory.takes.map((take) => take.key)).size).toBe(1);
    });
  });

  describe("headers on every answer of a limited route", () => {
    it("carries the RateLimit headers on a problem a later stage or the handler answers with", async () => {
      const missing = route(limited("/api/v1/open", "open", "public"), () => {
        throw new ProblemError("not_found", "No such item.");
      });
      const { get } = build([missing]);
      const response = await get("/api/v1/open");
      expect(response.status).toBe(404);
      expect(response.headers.get("ratelimit-policy")).toBe('"public";q=300;w=60');
      expect(response.headers.get("ratelimit")).toBe('"public";r=299;t=1');
    });
  });

  describe("a limiter that cannot decide", () => {
    it("answers 503 unavailable, logs the failure and reports it when the storage fails", async () => {
      const captured: unknown[] = [];
      let handled = 0;
      const counted = route(limited("/api/v1/open", "open", "public"), () => {
        handled += 1;
        return ok();
      });
      const failure = new Error("connection refused: db.internal:5432");
      const { get, logger } = build([counted], {
        limiter: () => ({ available: true, consume: () => Promise.reject(failure) }),
        errors: {
          available: true,
          capture: (error) => {
            captured.push(error);
            return Promise.resolve();
          },
        },
      });
      const response = await get("/api/v1/open");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "unavailable", status: 503 });
      expect(handled).toBe(0);
      const logged = logger.entries.find((entry) => entry.message === "Rate limiter failed");
      expect(logged?.level).toBe("error");
      expect(logged?.fields["bucket"]).toBe("public");
      expect(JSON.stringify(logger.entries)).not.toContain("db.internal");
      await Promise.resolve();
      expect(captured).toEqual([failure]);
    });

    it("answers 503 when the rate limiter is not configured, so no limited route goes unthrottled", async () => {
      const { get } = build([PUBLIC], { limiter: () => unconfigured().rateLimit });
      const response = await get("/api/v1/open");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "unavailable" });
    });

    it("answers 503 when the port refuses with PortUnavailable", async () => {
      const { get } = build([PUBLIC], {
        limiter: () => ({ available: true, consume: () => Promise.reject(new PortUnavailable("rateLimit", "unavailable")) }),
      });
      expect((await get("/api/v1/open")).status).toBe(503);
    });

    it("answers 503 for a bucket the registry does not know", async () => {
      const unknown = route(limited("/api/v1/open", "open", "not_a_bucket" as RateBucket));
      const { get, logger } = build([unknown]);
      expect((await get("/api/v1/open")).status).toBe(503);
      expect(logger.entries.map((entry) => entry.message)).toContain("Rate limiter failed");
    });

    it("does not fail a request that no limit applies to when the limiter is down", async () => {
      const none = route(limited("/api/v1/probe", "probe", "none"));
      const { get } = build([none], { limiter: () => unconfigured().rateLimit });
      expect((await get("/api/v1/probe")).status).toBe(200);
    });
  });
});

describe("the bucket registry", () => {
  it("holds exactly the buckets an operation can declare, except none", () => {
    expect([...RATE_LIMIT_BUCKETS].sort()).toEqual(RATE_BUCKETS.filter((bucket) => bucket !== "none").sort());
  });

  it("gives every bucket a limit per IP, so that stage 3a covers each of them", () => {
    const registry = createRateLimitRegistry(serverConfig());
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const limits = registry.scopesOf(bucket) ?? [];
      expect(limits[0]?.scope, bucket).toBe("ip");
      expect(limits[0]?.name, bucket).toBe(bucket);
      expect(registry.window(bucket), bucket).toBeDefined();
    }
  });

  it("names the limits of each bucket as the rate-limit port sees them", () => {
    const registry = createRateLimitRegistry(serverConfig());
    expect(registry.scopesOf("go")?.map((limit) => limit.name)).toEqual(["go", "go:account"]);
    expect(registry.scopesOf("ai")?.map((limit) => limit.name)).toEqual(["ai", "ai:account", "ai:workspace"]);
    expect(registry.scopesOf("login")?.map((limit) => limit.name)).toEqual(["login", "login:email"]);
    expect(registry.scopesOf("none")).toBeUndefined();
    expect(registry.window("read")).toEqual({ capacity: 1200, refillPerSecond: 20 });
    expect(registry.window("ai:workspace")).toEqual({ capacity: 600, refillPerSecond: 600 / 3600 });
    expect(registry.window("ai")).toEqual({ capacity: 60, refillPerSecond: 60 / 3600 });
    expect(registry.window("ai:account")).toEqual({ capacity: 60, refillPerSecond: 60 / 3600 });
  });
});
