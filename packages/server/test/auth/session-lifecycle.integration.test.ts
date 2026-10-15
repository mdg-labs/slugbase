import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOGIN,
  SESSION_COOKIE,
  ageSession,
  getWith,
  issuedToken,
  markPasswordChangedNow,
  postJson,
  seedAccount,
  serveAuth,
  signInAttempt,
  sessionRow,
  sha256,
  signInAs,
  storeFor,
  type AuthWorld,
  type SeededAccount,
  type SignedIn,
} from "./support.ts";

// The auth/sessions suite of doc 08 section 3.5 (doc 10 T4), for the parts of
// the session that sit on the database clock and on the wire. Already asserted
// elsewhere, and not repeated here:
//  - rotation on sign-in, and revocation on the next request: login.integration
//    ("rotation (T4)", "the session cookie at stage 4"), sessions.integration;
//  - rotation on a password change, and the other devices' cookies refused:
//    reauth.integration ("changes the password, keeps this device signed in
//    under a rotated cookie ...");
//  - the stored token hash, the coarse network and the initial 30, 90 and 180
//    day limits: login.integration.
// The database clock decides every expiry (sys_session_lookup reads
// clock_timestamp()), so no clock can be injected: a test lets days pass for a
// session by moving every instant the row recorded back (`ageSession`), which
// the lookup cannot tell from the days having passed.

const DAY_MS = 24 * 60 * 60 * 1000;
const ME = "/api/v1/me";
const SESSIONS = "/api/v1/me/sessions";
const REAUTH = "/api/v1/me/reauth";
const PASSWORD = "/api/v1/me/password";
const LOGOUT = "/api/v1/auth/logout";
const NEW_PASSWORD = "a brand new password for this account";
const COOKIE_MAX_AGE = "Max-Age=15552000";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

async function statusOf(world: AuthWorld, browser: SignedIn): Promise<number> {
  return (await getWith(world, ME, browser.token)).status;
}

function rowTimes(row: { created_at: Date; last_seen_at: Date; expires_at: Date; absolute_expires_at: Date }) {
  return {
    sliding: row.expires_at.getTime() - row.last_seen_at.getTime(),
    absolute: row.absolute_expires_at.getTime() - row.created_at.getTime(),
  };
}

describe("only hashes at rest (T4)", () => {
  it("keeps no token value in the sessions table, in a response other than the Set-Cookie that issues it, or in a log line", async () => {
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: "1" } });
    const account = await seedAccount(database());
    const cookieOf = (token: string): { cookie: string } => ({ cookie: `${SESSION_COOKIE}=${token}` });
    const seen: { readonly name: string; readonly response: Response }[] = [];
    const record = (name: string, response: Response): Response => {
      seen.push({ name, response: response.clone() });
      return response;
    };
    const signIn = async (name: string, password: string, remember: boolean): Promise<string> => {
      const response = record(name, await world.server.fetch(postJson(world.origin, LOGIN, { email: account.email, password, remember }, { forwardedFor: "203.0.113.57", userAgent: "Firefox/131.0" })));
      return issuedToken(response) ?? "";
    };
    const tableText = async (): Promise<string> => {
      const rows = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ row: string }[]>`SELECT s::text AS row FROM sessions s WHERE s.account_id = ${account.id}`;
      });
      return rows.map((row) => row.row).join("\n");
    };
    const forms = (token: string): string[] => {
      const bytes = Buffer.from(token, "base64url");
      return [token, bytes.toString("hex"), bytes.toString("base64")];
    };
    const hashOf = (token: string): string => sha256(Buffer.from(token, "base64url")).toString("hex");

    const plain = await signIn("sign-in", account.password, false);
    const remembered = await signIn("sign-in remembered", account.password, true);
    const beforeChange = await tableText();

    record("me", await getWith(world, ME, plain));
    record("sessions", await getWith(world, SESSIONS, plain));
    record("reauth wrong", await world.server.fetch(postJson(world.origin, REAUTH, { password: "not the password" }, cookieOf(plain))));
    record("reauth", await world.server.fetch(postJson(world.origin, REAUTH, { password: account.password }, cookieOf(plain))));
    const changed = record("password change", await world.server.fetch(postJson(world.origin, PASSWORD, { currentPassword: account.password, newPassword: NEW_PASSWORD }, cookieOf(plain))));
    const rotated = issuedToken(changed) ?? "";
    record("me after rotation", await getWith(world, ME, rotated));
    record("old token refused", await getWith(world, ME, plain));
    const later = await signIn("sign-in again", NEW_PASSWORD, false);
    const afterChange = await tableText();
    record("sign-out", await world.server.fetch(postJson(world.origin, LOGOUT, {}, cookieOf(later))));

    const tokens = [plain, remembered, rotated, later];
    expect(tokens.every((token) => token !== "")).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);

    // The scan can find a token where it is: the response that issues one carries it in Set-Cookie, and nowhere else.
    const issuers = new Map([[plain, "sign-in"], [remembered, "sign-in remembered"], [rotated, "password change"], [later, "sign-in again"]]);
    for (const { name, response } of seen) {
      const issued = [...issuers].filter(([, issuer]) => issuer === name).map(([token]) => token);
      for (const token of issued) {
        expect(response.headers.get("set-cookie"), name).toContain(token);
      }
      const headers = [...response.headers]
        .filter(([header]) => issued.length === 0 || header !== "set-cookie")
        .map(([header, value]) => `${header}: ${value}`)
        .join("\n");
      const body = await response.text();
      for (const token of tokens) {
        for (const form of forms(token)) {
          expect(headers, `${name} headers`).not.toContain(form);
          expect(body, `${name} body`).not.toContain(form);
        }
      }
    }

    // The table holds the SHA-256 of each live token and no form of any token.
    expect(beforeChange).toContain(hashOf(plain));
    expect(beforeChange).toContain(hashOf(remembered));
    expect(afterChange).toContain(hashOf(rotated));
    expect(afterChange).toContain(hashOf(later));
    for (const text of [beforeChange, afterChange]) {
      for (const token of tokens) {
        for (const form of forms(token)) {
          expect(text).not.toContain(form);
        }
      }
    }

    expect(world.logs.requests.length).toBeGreaterThan(0);
    const logged = JSON.stringify([world.logs.entries, world.logs.requests]);
    for (const token of tokens) {
      for (const form of forms(token)) {
        expect(logged).not.toContain(form);
      }
    }
  });
});

describe.each([
  { scheme: "https", appOrigin: "https://bookmarks.example.com", name: "__Host-slugbase_session", other: "slugbase_session", secure: "; Secure" },
  { scheme: "http", appOrigin: "http://localhost:5173", name: "slugbase_session", other: "__Host-slugbase_session", secure: "" },
])("the cookie's attributes under an $scheme origin (T4)", ({ appOrigin, name, other, secure }) => {
  const issued = `; ${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  const cleared = `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

  async function serve(): Promise<{ world: AuthWorld; account: SeededAccount }> {
    return { world: serveAuth(database(), store, { env: { APP_ORIGIN: appOrigin } }), account: await seedAccount(database()) };
  }

  it("is host-only, HttpOnly, SameSite=Lax and Secure only over https, on a sign-in with and without remember", async () => {
    const { world, account } = await serve();
    expect(world.origin).toBe(appOrigin);
    for (const remember of [false, true]) {
      const response = await signInAttempt(world, account, { remember });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      const token = issuedToken(response, name);
      expect(token).toBeDefined();
      expect(response.headers.get("set-cookie")).toBe(`${name}=${token ?? ""}${issued}`);
      expect(response.headers.get("set-cookie")).not.toMatch(/Domain/i);
    }
  });

  it("is the same on the cookie a password change rotates to, and a sign-out and a revocation of the current session clear it with the same attributes", async () => {
    const { world: served, account } = await serve();
    const here = await signInAs(served, database(), account, {}, name);
    const cookie = `${name}=${here.token}`;
    expect((await served.server.fetch(postJson(served.origin, REAUTH, { password: account.password }, { cookie }))).status).toBe(204);

    const changed = await served.server.fetch(postJson(served.origin, PASSWORD, { currentPassword: account.password, newPassword: NEW_PASSWORD }, { cookie }));
    expect(changed.status).toBe(204);
    const rotated = issuedToken(changed, name);
    expect(rotated).toBeDefined();
    expect(changed.headers.getSetCookie()).toEqual([`${name}=${rotated ?? ""}${issued}`]);

    const signedOut = await served.server.fetch(postJson(served.origin, LOGOUT, {}, { cookie: `${name}=${rotated ?? ""}` }));
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.getSetCookie()).toEqual([cleared]);

    const again = await signInAs(served, database(), { ...account, password: NEW_PASSWORD }, {}, name);
    const revoked = await served.server.fetch(
      new Request(new URL(`${SESSIONS}?includeCurrent=true`, served.origin), { method: "DELETE", headers: { origin: served.origin, "content-type": "application/json", cookie: `${name}=${again.token}` } }),
    );
    expect(revoked.status).toBe(204);
    expect(revoked.headers.getSetCookie()).toEqual([cleared]);
  });

  it("is read under this scheme's name only: a session under the other scheme's name is not a session", async () => {
    const { world: served, account } = await serve();
    const here = await signInAs(served, database(), account, {}, name);
    expect((await getWith(served, ME, here.token, name)).status).toBe(200);
    expect((await getWith(served, ME, here.token, other)).status).toBe(401);
  });
});

describe("sliding, remember-me and absolute expiry (T4)", () => {
  async function plainAndRemembered() {
    const world = serveAuth(database(), store);
    const account = await seedAccount(database());
    const plain = await signInAs(world, database(), account);
    const remembered = await signInAs(world, database(), account, { remember: true });
    return { world, account, plain, remembered };
  }

  it("moves the sliding expiry to 30 days (90 with remember) after a request made more than a minute after the last, and not for one inside the minute", async () => {
    const { world, account, plain, remembered } = await plainAndRemembered();

    const fresh = await sessionRow(database(), account.id, plain.sessionId);
    expect(await statusOf(world, plain)).toBe(200);
    expect(await statusOf(world, plain)).toBe(200);
    const untouched = await sessionRow(database(), account.id, plain.sessionId);
    expect(untouched.last_seen_at).toEqual(fresh.last_seen_at);
    expect(untouched.expires_at).toEqual(fresh.expires_at);

    for (const [browser, days] of [[plain, 30], [remembered, 90]] as const) {
      await ageSession(database(), browser.sessionId, 10);
      const before = await sessionRow(database(), account.id, browser.sessionId);
      expect(await statusOf(world, browser)).toBe(200);
      const after = await sessionRow(database(), account.id, browser.sessionId);
      expect(after.last_seen_at.getTime() - before.last_seen_at.getTime(), `${String(days)} days`).toBeGreaterThanOrEqual(9 * DAY_MS);
      expect(rowTimes(after).sliding, `${String(days)} days`).toBe(days * DAY_MS);
      expect(rowTimes(after).absolute, `${String(days)} days`).toBe(180 * DAY_MS);
    }
  });

  it("refuses a session unused for 30 days, or 90 with remember, and keeps one used within them", async () => {
    const { world, account, plain, remembered } = await plainAndRemembered();
    const later = await signInAs(world, database(), account);
    const laterRemembered = await signInAs(world, database(), account, { remember: true });
    await ageSession(database(), plain.sessionId, 31);
    await ageSession(database(), remembered.sessionId, 31);
    await ageSession(database(), later.sessionId, 29);
    await ageSession(database(), laterRemembered.sessionId, 91);

    expect(await statusOf(world, plain)).toBe(401);
    expect(await statusOf(world, remembered)).toBe(200);
    expect(await statusOf(world, later)).toBe(200);
    expect(await statusOf(world, laterRemembered)).toBe(401);
  });

  it("never slides past 180 days after sign-in: the expiry is capped there, and the session is refused after it though a plain slide would still be open", async () => {
    const { world, account, plain, remembered } = await plainAndRemembered();
    for (const [browser, step, steps] of [[plain, 29, 6], [remembered, 80, 2]] as const) {
      for (let at = 0; at < steps; at += 1) {
        await ageSession(database(), browser.sessionId, step);
        expect(await statusOf(world, browser)).toBe(200);
      }
      const capped = await sessionRow(database(), account.id, browser.sessionId);
      const aged = step * steps;
      expect(capped.expires_at, `${String(aged)} days`).toEqual(capped.absolute_expires_at);
      expect(capped.absolute_expires_at.getTime() - capped.created_at.getTime()).toBe(180 * DAY_MS);

      await ageSession(database(), browser.sessionId, 181 - aged);
      expect(await statusOf(world, browser), `${String(aged)} days`).toBe(401);
    }
  });

  it("refuses a session past its absolute expiry although its sliding window is still open", async () => {
    const { world, account, plain } = await plainAndRemembered();
    await ageSession(database(), plain.sessionId, 181);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE sessions SET expires_at = now() + interval '10 days' WHERE id = ${plain.sessionId}`;
    });
    const row = await sessionRow(database(), account.id, plain.sessionId);
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(row.absolute_expires_at.getTime()).toBeLessThan(Date.now());
    expect(await statusOf(world, plain)).toBe(401);
  });
});

describe("password_changed_at (T4)", () => {
  it("refuses every session created before it and leaves none of them in the list, and honours one created after it", async () => {
    const world = serveAuth(database(), store);
    const account = await seedAccount(database());
    const bystander = await seedAccount(database());
    const laptop = await signInAs(world, database(), account);
    const phone = await signInAs(world, database(), account, { remember: true });
    const theirs = await signInAs(world, database(), bystander);
    expect(await statusOf(world, laptop)).toBe(200);

    await markPasswordChangedNow(database(), account.id);

    expect(await statusOf(world, laptop)).toBe(401);
    expect(await statusOf(world, phone)).toBe(401);
    const after = await signInAs(world, database(), account);
    expect(await statusOf(world, after)).toBe(200);
    const listed = (await (await getWith(world, SESSIONS, after.token)).json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toEqual([after.sessionId]);
    expect(await statusOf(world, theirs)).toBe(200);
  });
});
