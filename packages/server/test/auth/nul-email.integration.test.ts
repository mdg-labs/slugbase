import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { urlOf } from "../migrate/support.ts";
import { CREDENTIAL_ENV, FORGOT, REGISTER, RESEND, STRONG_PASSWORD } from "./credential-flows.ts";
import { attemptLogin, postJson, seedAccount, serveAuth, storeFor, type AuthWorld } from "./support.ts";

// A NUL character in the email of a request that looks an account up by it (doc 04 section 2.3, doc 10 T8, T9): PostgreSQL cannot hold
// U+0000 in text, so the address must not reach the lookup. The sign-in, the password reset, the verification resend and the
// registration refuse it with 422 validation_failed, through the whole chain over the migrated database, and the answer is the same for
// an address that has an account and one that has none.

const NUL = "\u0000";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, 120_000);

afterAll(async () => {
  await store.close();
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { readonly path: string }[];
}

async function expectRefused(response: Response): Promise<Problem> {
  expect(response.status).toBe(422);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("set-cookie")).toBeNull();
  const problem = (await response.json()) as Problem;
  expect(problem.code).toBe("validation_failed");
  expect(problem.errors?.map((error) => error.path)).toEqual(["email"]);
  return problem;
}

function post(world: AuthWorld, path: string, body: unknown, forwardedFor?: string): Promise<Response> {
  return world.server.fetch(postJson(world.origin, path, body, forwardedFor === undefined ? {} : { forwardedFor }));
}

describe("a NUL character in the email of a lookup", () => {
  it("is refused at sign-in with 422, not 500, whether or not an account holds the address", async () => {
    const world = serveAuth(database(), store);
    const known = await seedAccount(database());

    const unknown = await expectRefused(await attemptLogin(world, { email: `nobody${NUL}@example.test`, password: "some password" }));
    const trailing = await expectRefused(await attemptLogin(world, { email: `${known.email}${NUL}`, password: known.password }));
    const leading = await expectRefused(await attemptLogin(world, { email: `${NUL}${known.email}`, password: known.password }));

    const strip = ({ errors, code, status }: Problem): unknown => ({ errors, code, status });
    expect(strip(trailing)).toEqual(strip(unknown));
    expect(strip(leading)).toEqual(strip(unknown));
  }, 60_000);

  it("is refused at sign-in before the per-email limit is taken, so no number of attempts reaches it", async () => {
    const world = serveAuth(database(), store, { env: { RATE_LIMIT_LOGIN_EMAIL: "1/hour" } });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expectRefused(await attemptLogin(world, { email: `a${NUL}b@example.test`, password: "some password" }));
    }
    expect((await attemptLogin(world, { email: "someone@example.test", password: "some password" })).status).toBe(401);
  }, 60_000);

  it("counts a refused sign-in against the per-IP limit like any other attempt, known address or not", async () => {
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: "1", RATE_LIMIT_LOGIN_IP: "2/min" } });
    const address = "198.51.100.40";

    await expectRefused(await attemptLogin(world, { email: `a${NUL}b@example.test`, password: "some password", forwardedFor: address }));
    await expectRefused(await attemptLogin(world, { email: `a${NUL}b@example.test`, password: "some password", forwardedFor: address }));
    expect((await attemptLogin(world, { email: `a${NUL}b@example.test`, password: "some password", forwardedFor: address })).status).toBe(429);

    const other = "198.51.100.41";
    expect((await attemptLogin(world, { email: "someone@example.test", password: "some password", forwardedFor: other })).status).toBe(401);
  }, 60_000);

  it.each([
    ["the password reset", FORGOT],
    ["the verification resend", RESEND],
  ])("is refused with 422 in %s, whether or not an account holds the address", async (_name, path) => {
    const world = serveAuth(database(), store, { env: CREDENTIAL_ENV });
    const known = await seedAccount(database(), { emailVerified: true });

    await expectRefused(await post(world, path, { email: `nobody${NUL}@example.test` }));
    await expectRefused(await post(world, path, { email: `${known.email}${NUL}` }));
  }, 60_000);

  it("is refused with 422 in the registration", async () => {
    const world = serveAuth(database(), store, { env: CREDENTIAL_ENV });

    await expectRefused(await post(world, REGISTER, { displayName: "Ada Lovelace", email: `a${NUL}b@example.test`, password: STRONG_PASSWORD }));
  }, 60_000);
});
