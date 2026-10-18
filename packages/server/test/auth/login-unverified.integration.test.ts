import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { urlOf } from "../migrate/support.ts";
import { attemptLogin, getWith, issuedToken, seedAccount, serveAuth, sessionRows, signInAttempt, storeFor } from "./support.ts";

// POST /api/v1/auth/login for an account whose address was never verified (doc 02 section 2.3, doc 04
// sections 3.2 and 10.2, doc 10 T8). Where verification is required, a correct password answers 403
// email_unverified and creates no session, while a wrong one still answers the generic 401, so the
// response never says more than the password proves. Where it is optional, the account signs in and
// GET /me reports emailVerified: false.

const HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 40_000;
const REQUIRED = { EMAIL_VERIFICATION_REQUIRED: "true" };
const OPTIONAL = { EMAIL_VERIFICATION_REQUIRED: "false" };

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
}, 30_000);

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
});

describe("sign-in of an unverified account where verification is required", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers 403 email_unverified for the correct password and creates no session and sets no cookie", async () => {
    const world = serveAuth(database(), store, { env: REQUIRED });
    const account = await seedAccount(database());

    const response = await signInAttempt(world, account);

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "email_unverified", status: 403 });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await sessionRows(database(), account.id)).toEqual([]);
  });

  it("answers a wrong password for an unverified account with the same 401 as an unknown address", async () => {
    const world = serveAuth(database(), store, { env: REQUIRED });
    const account = await seedAccount(database());

    const wrong = await signInAttempt(world, account, { password: "not the password at all" });
    const unknown = await attemptLogin(world, { email: "nobody@example.test", password: "not the password at all" });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = async (response: Response) =>
      Object.fromEntries(Object.entries((await response.json()) as Record<string, unknown>).filter(([name]) => name !== "requestId"));
    expect(await strip(wrong)).toEqual(await strip(unknown));
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await sessionRows(database(), account.id)).toEqual([]);
  });

  it("answers a disabled unverified account with the generic 401, not the verification answer", async () => {
    const world = serveAuth(database(), store, { env: REQUIRED });
    const account = await seedAccount(database(), { disabled: true });

    const response = await signInAttempt(world, account);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("signs a verified account in as before", async () => {
    const world = serveAuth(database(), store, { env: REQUIRED });
    const account = await seedAccount(database(), { emailVerified: true });

    const response = await signInAttempt(world, account);

    expect(response.status).toBe(200);
    expect(issuedToken(response)).toBeDefined();
    expect(await sessionRows(database(), account.id)).toHaveLength(1);
  });
});

describe("sign-in of an unverified account where verification is optional", { timeout: TEST_TIMEOUT_MS }, () => {
  it("signs it in and GET /me reports emailVerified: false", async () => {
    const world = serveAuth(database(), store, { env: OPTIONAL });
    const account = await seedAccount(database());

    const response = await signInAttempt(world, account);
    const token = issuedToken(response);

    expect(response.status).toBe(200);
    expect(token).toBeDefined();
    const me = await getWith(world, "/api/v1/me", token ?? null);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ account: { emailVerified: false } });
  });
});
