import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { urlOf } from "../migrate/support.ts";
import { CREDENTIAL_ENV, redeemFlows, requestFlows, type RequestFlow } from "./credential-flows.ts";
import { attemptLogin, freshSessionCookie, postJson, seedAccount, serveAuth, storeFor, type AuthWorld } from "./support.ts";

// The auth/rate-limits suite of doc 08 section 3.5 (doc 10 T9, doc 02 section
// 16, doc 04 section 7), over the shipped defaults and the whole chain: the
// `login` limits per IP and per email, the `setup` limit per IP, the client
// address taken only across the trusted proxy hops, and a 429 that says when to
// come back. The limiter is the in-memory one whose clock moves only when the
// test says, so no assertion here depends on how long a run takes.
//
// Already asserted elsewhere, and not repeated here: the 10 a minute per IP and
// 20 an hour per email of login under explicit limits, the spellings of one
// address counted as one, and the right password refused over the limit
// (login.integration, "limits (T9)"); the setup limit at an explicit 3 an hour
// (routes/setup.integration, "the setup rate limit"); the `X-Forwarded-For`
// rules and the /64 key of the limiter itself (http/rate-limit.integration,
// http/trusted-proxy.test, http/rate-limit.test). `setup` has no per-email
// limit: its bucket has the one per-IP limit (doc 04 section 7).
//
// What this file adds: the defaults as shipped; that a different address or
// address bucket is not limited; that Retry-After is the wait that works; the
// header rules through the login and setup routes themselves; and the /64 key
// through login.

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The credential flows queue their mail through pg-boss, whose schema the image entrypoint creates before the server starts.
  await runMigrations({ url: urlOf(database().owner) });
}, 120_000);

afterAll(async () => {
  await store.close();
});

const SETUP = "/api/v1/setup";
const SETUP_BODY = { displayName: "First Admin", email: "admin@example.test", password: "a long enough password", workspaceName: "Home" };

let attemptNumber = 0;

/** A sign-in attempt for an address nobody has, so that only the per-IP count moves. */
function strangerAttempt(world: AuthWorld, forwardedFor?: string): Promise<Response> {
  attemptNumber += 1;
  return attemptLogin(world, {
    email: `stranger${String(attemptNumber)}@example.test`,
    password: "some password",
    ...(forwardedFor === undefined ? {} : { forwardedFor }),
  });
}

function setupAttempt({ server, origin }: AuthWorld, forwardedFor: string): Promise<Response> {
  return server.fetch(postJson(origin, SETUP, { ...SETUP_BODY, setupToken: "a token nobody issued" }, { forwardedFor }));
}

async function expectDenied(response: Response, policy: string, longestWaitSeconds: number): Promise<number> {
  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "rate_limited", status: 429 });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("ratelimit-policy")).toContain(policy);
  const retryAfter = response.headers.get("retry-after") ?? "";
  expect(retryAfter).toMatch(/^[1-9]\d*$/);
  expect(Number(retryAfter)).toBeLessThanOrEqual(longestWaitSeconds);
  return Number(retryAfter);
}

/**
 * Takes `allowed` attempts for each of two clients, and the attempt after them from each, which is the denial: its
 * answer is checked and the wait it names returned. The two denials are made together, so one wait fits both.
 */
async function exhaust(
  allowed: number,
  attempt: (client: 1 | 2) => Promise<Response>,
  policy: string,
  longestWaitSeconds: number,
  allowedStatus = 401,
): Promise<number> {
  for (const client of [1, 2] as const) {
    for (let count = 0; count < allowed; count += 1) {
      expect((await attempt(client)).status, `client ${String(client)}, attempt ${String(count)}`).toBe(allowedStatus);
    }
  }
  const first = await expectDenied(await attempt(1), policy, longestWaitSeconds);
  const second = await expectDenied(await attempt(2), policy, longestWaitSeconds);
  expect(second).toBe(first);
  return first;
}

async function accountCount(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts`;
  });
  return rows[0]?.count ?? -1;
}

describe("the login limits as shipped (T9)", () => {
  it("allows 10 attempts a minute per IP, answers the 11th with 429 and a Retry-After that works, and leaves another IP alone", async () => {
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: "1" }, openLimits: false });
    const retryAfter = await exhaust(10, async (client) => strangerAttempt(world, `198.51.100.${String(client)}`), '"login";q=10;w=60', 60);

    expect((await strangerAttempt(world, "198.51.100.9")).status).toBe(401);
    // The wait it names is enough for the first address, and a second less is not enough for the second.
    world.limiter.advance(retryAfter - 1);
    expect((await strangerAttempt(world, "198.51.100.2")).status).toBe(429);
    world.limiter.advance(1);
    expect((await strangerAttempt(world, "198.51.100.1")).status).toBe(401);
  });

  it("allows 20 attempts an hour per email, whatever the IP, answers the 21st with 429 and a Retry-After that works, and leaves another email alone", async () => {
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: "1" }, openLimits: false });
    let address = 0;
    const next = (): string => {
      address += 1;
      return `198.51.100.${String(address)}`;
    };
    const emails = ["victim.one@example.test", "victim.two@example.test"];
    const retryAfter = await exhaust(
      20,
      (client) => attemptLogin(world, { email: emails[client - 1] ?? "", password: "some password", forwardedFor: next() }),
      '"login:email";q=20;w=3600',
      3600,
    );

    expect((await attemptLogin(world, { email: "someone.else@example.test", password: "some password", forwardedFor: next() })).status).toBe(401);
    world.limiter.advance(retryAfter - 1);
    expect((await attemptLogin(world, { email: emails[1] ?? "", password: "some password", forwardedFor: next() })).status).toBe(429);
    world.limiter.advance(1);
    expect((await attemptLogin(world, { email: emails[0] ?? "", password: "some password", forwardedFor: next() })).status).toBe(401);
  });
});

describe("the setup limit as shipped (T9)", () => {
  it("allows 10 attempts an hour per IP, wrong ones included, answers the 11th with 429 and a Retry-After, creates no account, and leaves another IP and the login bucket alone", async () => {
    const world = serveAuth(database(), store, { env: { SETUP_TOKEN_REQUIRED: "true", TRUSTED_PROXY_HOPS: "1" }, openLimits: false });
    const accounts = await accountCount();
    const retryAfter = await exhaust(10, (client) => setupAttempt(world, `198.51.100.${String(client)}`), '"setup";q=10;w=3600', 3600, 403);
    expect(await accountCount()).toBe(accounts);

    expect((await setupAttempt(world, "198.51.100.9")).status).toBe(403);
    expect((await strangerAttempt(world, "198.51.100.1")).status).toBe(401);
    world.limiter.advance(retryAfter - 1);
    expect((await setupAttempt(world, "198.51.100.2")).status).toBe(429);
    world.limiter.advance(1);
    expect((await setupAttempt(world, "198.51.100.1")).status).toBe(403);
  });
});

describe("the client address is taken only across the trusted hops (T9)", () => {
  interface Case {
    readonly name: string;
    readonly hops: number;
    /** The `X-Forwarded-For` of the nth request of one client that rotates every entry it can write. */
    readonly rotating: (attempt: number) => string;
    /** A request that the trusted proxy sees from another address. */
    readonly other: string;
    /** Whether that request has a bucket of its own: with no trusted hop the header is not read at all. */
    readonly ownBucket: boolean;
  }

  const cases: readonly Case[] = [
    { name: "with no trusted hop, whatever the header says", hops: 0, rotating: (n) => `203.0.113.${String(n + 1)}`, other: "203.0.113.200", ownBucket: false },
    { name: "with one trusted hop, the entries to the left of the one the proxy wrote", hops: 1, rotating: (n) => `203.0.113.${String(n + 1)}, 198.51.100.7`, other: "203.0.113.1, 198.51.100.8", ownBucket: true },
    {
      name: "with two trusted hops, the entries to the left of the second from the right and the one nearest the server",
      hops: 2,
      rotating: (n) => `203.0.113.${String(n + 1)}, 198.51.100.7, 192.0.2.${String(n + 1)}`,
      other: "203.0.113.1, 198.51.100.8, 192.0.2.1",
      ownBucket: true,
    },
    { name: "with one trusted hop, an entry the proxy wrote that is not an address", hops: 1, rotating: (n) => `203.0.113.${String(n + 1)}, junk-${String(n)}`, other: "203.0.113.1, 198.51.100.8", ownBucket: true },
  ];

  it.each(cases)("does not let a client that rotates what it can write escape the login limit: $name", async ({ hops, rotating, other, ownBucket }) => {
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: String(hops), RATE_LIMIT_LOGIN_IP: "3/min" }, openLimits: false });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await strangerAttempt(world, rotating(attempt))).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    // The bucket is the address the proxy appended, not a fixed one: another address has its own.
    expect((await strangerAttempt(world, other)).status).toBe(ownBucket ? 401 : 429);
  });

  it("does not let a client that rotates what it can write escape the setup limit", async () => {
    const world = serveAuth(database(), store, { env: { SETUP_TOKEN_REQUIRED: "true", TRUSTED_PROXY_HOPS: "1", RATE_LIMIT_SETUP_IP: "3/hour" }, openLimits: false });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await setupAttempt(world, `203.0.113.${String(attempt + 1)}, 198.51.100.7`)).status);
    }
    expect(statuses).toEqual([403, 403, 403, 429, 429, 429]);
    expect((await setupAttempt(world, "203.0.113.1, 198.51.100.8")).status).toBe(403);
  });
});

describe("the IP bucket of an IPv6 address is its /64, and an IPv4-mapped one is its IPv4 address (T9)", () => {
  async function limitedAfterThree(forwardedFor: readonly string[]): Promise<number[]> {
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: "1", RATE_LIMIT_LOGIN_IP: "3/min" }, openLimits: false });
    const statuses: number[] = [];
    for (const address of forwardedFor) {
      statuses.push((await strangerAttempt(world, address)).status);
    }
    return statuses;
  }

  it("counts the addresses of one /64 together, however they are written, and another /64 apart", async () => {
    expect(
      await limitedAfterThree(["2001:db8:1:2::1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:0DB8:0001:0002:0:0:0:ffff", "2001:db8:1:2:1::1", "2001:db8:1:3::1"]),
    ).toEqual([401, 401, 401, 429, 401]);
  });

  it("counts an IPv4-mapped address with the IPv4 address it maps", async () => {
    expect(await limitedAfterThree(["::ffff:198.51.100.7", "198.51.100.7", "::ffff:c633:6407", "0:0:0:0:0:ffff:198.51.100.7", "198.51.100.8"])).toEqual([401, 401, 401, 429, 401]);
  });
});

const mail = new InMemoryMail();
const clientAddress = (client: 1 | 2): string => `198.51.100.${String(client)}`;
let addressNumber = 0;

/** An address nobody has, so that no account is looked up and only the counts move. */
function freshEmail(): string {
  addressNumber += 1;
  return `flood.${String(addressNumber)}@example.test`;
}

function credentialWorld(env: Record<string, string> = {}): AuthWorld {
  return serveAuth(database(), store, { env: { ...CREDENTIAL_ENV, TRUSTED_PROXY_HOPS: "1", ...env }, openLimits: false, mail });
}

async function mailJobCount(): Promise<number> {
  const rows = await database().app<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'mail.send'`;
  return rows[0]?.count ?? -1;
}

/** The session the flow that needs one is asked with: an account of its own, signed in and re-authenticated. */
async function sessionFor(world: AuthWorld, flow: RequestFlow): Promise<string | undefined> {
  if (!flow.authenticated) {
    return undefined;
  }
  return freshSessionCookie(world, await seedAccount(database(), { emailVerified: true }), "198.51.100.250");
}

describe("the register limit as shipped (T9)", () => {
  const [register] = requestFlows;
  if (register === undefined) {
    throw new Error("the register flow is missing");
  }

  it("allows 5 registrations an hour per IP, answers the 6th with 429 and a Retry-After that works, creates nothing for the denied ones, and leaves another IP alone", async () => {
    const world = credentialWorld();
    const accounts = await accountCount();
    const jobs = await mailJobCount();
    const retryAfter = await exhaust(5, (client) => register.call(world, freshEmail(), { forwardedFor: clientAddress(client) }), '"register";q=5;w=3600', 3600, 202);
    // Only the ten that were let through left anything behind.
    expect(await accountCount()).toBe(accounts + 10);
    expect(await mailJobCount()).toBe(jobs + 10);

    expect((await register.call(world, freshEmail(), { forwardedFor: "198.51.100.9" })).status).toBe(202);
    world.limiter.advance(retryAfter - 1);
    expect((await register.call(world, freshEmail(), { forwardedFor: clientAddress(2) })).status).toBe(429);
    world.limiter.advance(1);
    expect((await register.call(world, freshEmail(), { forwardedFor: clientAddress(1) })).status).toBe(202);
  });

  it("has no limit per email: one address registered from six addresses is six 202s, so a repeat tells nothing about the account", async () => {
    const world = credentialWorld();
    const email = freshEmail();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect((await register.call(world, email, { forwardedFor: `198.51.100.${String(attempt)}` })).status, `attempt ${String(attempt)}`).toBe(202);
    }
  });
});

describe("the reset limits as shipped (T9)", () => {
  const resetFlows = requestFlows.filter((flow) => flow.bucket === "reset");

  it.each(resetFlows.map((flow) => [flow.name, flow] as const))(
    "%s: allows 5 requests an hour per IP, answers the 6th with 429 and a Retry-After that works, queues nothing for the denied ones, and leaves another IP alone",
    async (_name, flow) => {
      const world = credentialWorld();
      const cookie = await sessionFor(world, flow);
      const jobs = await mailJobCount();
      const retryAfter = await exhaust(5, (client) => flow.call(world, freshEmail(), { forwardedFor: clientAddress(client) }, cookie), '"reset";q=5;w=3600', 3600, 202);
      expect(await mailJobCount()).toBe(jobs + 10);

      expect((await flow.call(world, freshEmail(), { forwardedFor: "198.51.100.9" }, cookie)).status).toBe(202);
      world.limiter.advance(retryAfter - 1);
      expect((await flow.call(world, freshEmail(), { forwardedFor: clientAddress(2) }, cookie)).status).toBe(429);
      world.limiter.advance(1);
      expect((await flow.call(world, freshEmail(), { forwardedFor: clientAddress(1) }, cookie)).status).toBe(202);
    },
  );

  it.each(resetFlows.map((flow) => [flow.name, flow] as const))(
    "%s: allows 3 requests an hour per target email in any spelling and from any IP, answers the 4th with 429 and a Retry-After that works, queues nothing for it, and leaves another email alone",
    async (_name, flow) => {
      const world = credentialWorld();
      const cookie = await sessionFor(world, flow);
      const targets = [`Target.One.${String(++addressNumber)}@Example.test`, `target.two.${String(++addressNumber)}@example.test`];
      const spellings = [(email: string) => email, (email: string) => email.toLowerCase(), (email: string) => email.toUpperCase()];
      let address = 0;
      const next = (): string => {
        address += 1;
        return `198.51.100.${String(address)}`;
      };
      let attempts = 0;
      const jobs = await mailJobCount();
      const retryAfter = await exhaust(
        3,
        (client) => {
          const email = targets[client - 1] ?? "";
          attempts += 1;
          // The attempts name the address in all three spellings, which are one bucket.
          const spelling = spellings[attempts % 3] ?? spellings[0];
          return flow.call(world, spelling?.(email) ?? email, { forwardedFor: next() }, cookie);
        },
        '"reset:email";q=3;w=3600',
        3600,
        202,
      );
      expect(await mailJobCount()).toBe(jobs + 6);

      expect((await flow.call(world, freshEmail(), { forwardedFor: next() }, cookie)).status).toBe(202);
      world.limiter.advance(retryAfter - 1);
      expect((await flow.call(world, targets[1] ?? "", { forwardedFor: next() }, cookie)).status).toBe(429);
      world.limiter.advance(1);
      expect((await flow.call(world, targets[0] ?? "", { forwardedFor: next() }, cookie)).status).toBe(202);
    },
  );

  it("counts the three requests in one per-IP bucket and one per-email bucket", async () => {
    const world = credentialWorld();
    const cookies = await Promise.all(resetFlows.map((flow) => sessionFor(world, flow)));
    const call = (index: number, email: string, forwardedFor: string) => resetFlows[index]?.call(world, email, { forwardedFor }, cookies[index]) ?? Promise.reject(new Error("no such flow"));

    // Five requests from one address, two of them the same flow, then each of the three is over the limit.
    for (const index of [0, 1, 2, 0, 1]) {
      expect((await call(index, freshEmail(), "198.51.100.1")).status).toBe(202);
    }
    for (const index of [0, 1, 2]) {
      expect((await call(index, freshEmail(), "198.51.100.1")).status, resetFlows[index]?.name).toBe(429);
    }
    // Three requests for one email, one of each flow, from three addresses, then each of the three is over the limit.
    const email = freshEmail();
    for (const index of [0, 1, 2]) {
      expect((await call(index, email, `198.51.100.${String(index + 20)}`)).status, resetFlows[index]?.name).toBe(202);
    }
    for (const index of [0, 1, 2]) {
      expect((await call(index, email, `198.51.100.${String(index + 30)}`)).status, resetFlows[index]?.name).toBe(429);
    }
  });
});

describe("the token_redeem limit as shipped (T9)", () => {
  const unknownToken = "A".repeat(43);

  it.each(redeemFlows.map((flow) => [flow.name, flow] as const))(
    "%s: allows 10 redemptions an hour per IP, wrong ones included, answers the 11th with 429 and a Retry-After that works, and leaves another IP alone",
    async (_name, flow) => {
      const world = credentialWorld();
      const retryAfter = await exhaust(10, (client) => flow.call(world, unknownToken, { forwardedFor: clientAddress(client) }), '"token_redeem";q=10;w=3600', 3600, 410);

      expect((await flow.call(world, unknownToken, { forwardedFor: "198.51.100.9" })).status).toBe(410);
      world.limiter.advance(retryAfter - 1);
      expect((await flow.call(world, unknownToken, { forwardedFor: clientAddress(2) })).status).toBe(429);
      world.limiter.advance(1);
      expect((await flow.call(world, unknownToken, { forwardedFor: clientAddress(1) })).status).toBe(410);
    },
  );

  it("counts the four redemptions in one bucket, and leaves the request limits of the same address alone", async () => {
    const world = credentialWorld();
    const [verify, reset, confirm, cancel] = redeemFlows;
    const from = { forwardedFor: "198.51.100.1" };
    for (const flow of [verify, verify, verify, reset, reset, reset, confirm, confirm, cancel, cancel]) {
      expect((await flow?.call(world, unknownToken, from))?.status).toBe(410);
    }
    for (const flow of redeemFlows) {
      expect((await flow.call(world, unknownToken, from)).status, flow.name).toBe(429);
    }
    const [, , forgot] = requestFlows;
    expect((await forgot?.call(world, freshEmail(), from))?.status).toBe(202);
  });
});
