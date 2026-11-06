import { randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { appOrigin, STORAGE_STATE } from "../support/environment.ts";
import { invitationLink, waitForMail } from "../support/mailpit.ts";
import {
  crossSiteRefusalViolations,
  goHeaderViolations,
  healthViolations,
  leakedAccounts,
  leakedBookmarks,
  noStoreViolations,
  processedViolations,
  securityHeaderViolations,
  sessionCookieViolations,
  setupClosedViolations,
  unauthenticatedViolations,
  versionViolations,
  type Answer,
} from "../support/production-defaults.ts";
import { expect, test } from "../support/test.ts";

// The production defaults of the built image (doc 10 section 6 rule 3, doc 08 section 5.1): the image runs with NODE_ENV=production
// and an https APP_ORIGIN, as compose.yml ships it, and the stack serves it at that origin through the TLS proxy of the global setup.
// This journey speaks HTTP only (request contexts, no page) and holds the properties the audit rates against: the session cookie of a
// password sign-in (T4), the cross-site rules of a mutation that carries the session (T5), the response headers of the app, of the API
// and of /go (T5, T14), the probes (T22) and the closed setup endpoint (doc 10 section 2.1). The checks are the predicates of
// support/production-defaults.ts, which production-defaults.test.ts feeds a broken answer for each property. The startup refusals
// (a weak secret, an http origin, the owner role of the database) need a container with a bad configuration, which this image has no
// docker to start, so scripts/smoke-image.sh checks them. The in-process suites of the server (packages/server/test/http) prove the
// same rules against a server built in the test; this proves them against the image.
//
// The owner of the instance signed in with a password nobody keeps, and has a second factor besides, so the journey invites an address
// of its own, accepts the invitation as a new account with a password made up for the run, and signs in with that password: the
// answer to that sign-in is the one whose cookie is read. That is one invitation token redeemed (doc 08 section 5.1, "Redeeming
// tokens"), and the one password sign-in of the journey, well inside the limit of sign-in attempts (10 a minute, doc 04 section 7).
// The member's membership of the workspace ends when the journey ends (the owner removes it). The password, the session cookie and the API token are never printed: a message
// names the request and the property, not a value.

type Playwright = PlaywrightWorkerArgs["playwright"];

const NO_SESSION = { cookies: [], origins: [] };
const BOOKMARKS = "/api/v1/bookmarks";
const SAME_ORIGIN = { origin: appOrigin(), "sec-fetch-site": "same-origin", "content-type": "application/json" } as const;

function options(): { baseURL: string; ignoreHTTPSErrors: true } {
  return { baseURL: appOrigin(), ignoreHTTPSErrors: true };
}

/** What the predicates read of a response. A body that is not JSON (a redirect, a page) is undefined. */
async function answerOf(response: APIResponse): Promise<Answer> {
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  return {
    status: response.status(),
    headers: response.headers(),
    setCookies: response
      .headersArray()
      .filter(({ name }) => name.toLowerCase() === "set-cookie")
      .map(({ value }) => value),
    body,
  };
}

function expectStatus(response: APIResponse, status: number, what: string): void {
  // A message names the call and the statuses, never the body of an answer that may hold a token.
  expect(response.status(), `${what} answered ${String(response.status())}`).toBe(status);
}

function json(data?: unknown): { headers: Record<string, string>; data?: unknown } {
  return { headers: { ...SAME_ORIGIN }, ...(data === undefined ? {} : { data }) };
}

interface Member {
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
  /** Signed in with the password: its cookie jar holds the session. */
  readonly session: APIRequestContext;
  /** The `Set-Cookie` headers of that password sign-in. */
  readonly signInCookies: readonly string[];
}

/** The owner invites an address, the mail is read from Mailpit, the address accepts as a new account and signs in with its password. */
async function provisionMember(playwright: Playwright, token: string): Promise<Member> {
  const email = `production-defaults-${token}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const owner = await playwright.request.newContext({ ...options(), storageState: STORAGE_STATE });
  const visitor = await playwright.request.newContext({ ...options(), storageState: NO_SESSION });
  const session = await playwright.request.newContext({ ...options(), storageState: NO_SESSION });
  try {
    expectStatus(await owner.post("/api/v1/invitations", json({ email, role: "member" })), 201, "POST /api/v1/invitations");
    const mail = await waitForMail(email);
    const invitation = new URL(invitationLink(mail.text, appOrigin())).pathname.slice("/invite/".length);
    expectStatus(
      await visitor.post("/api/v1/invitations/accept", json({ token: invitation, displayName: `Defaults ${token}`, password })),
      201,
      "POST /api/v1/invitations/accept",
    );
    const signedIn = await session.post("/api/v1/auth/login", json({ email, password }));
    expectStatus(signedIn, 200, "POST /api/v1/auth/login");
    const signInCookies = (await answerOf(signedIn)).setCookies;
    const me = (await (await session.get("/api/v1/me")).json()) as { account?: { id?: unknown } };
    if (typeof me.account?.id !== "string") {
      throw new Error("GET /api/v1/me answered without the account's id");
    }
    return { email, password, accountId: me.account.id, session, signInCookies };
  } catch (error) {
    await session.dispose();
    throw error;
  } finally {
    await owner.dispose();
    await visitor.dispose();
  }
}

async function removeMember(playwright: Playwright, member: Member): Promise<void> {
  const owner = await playwright.request.newContext({ ...options(), storageState: STORAGE_STATE });
  try {
    // The member's bookmarks in the workspace go with the membership.
    expectStatus(await owner.delete(`/api/v1/members/${member.accountId}`, json({ content: "delete" })), 200, "DELETE /api/v1/members/{accountId}");
  } finally {
    await owner.dispose();
    await member.session.dispose();
  }
}

/** The addresses of the bookmarks the member has. */
async function bookmarkUrls(member: Member): Promise<string[]> {
  const response = await member.session.get(`${BOOKMARKS}?limit=100`);
  expectStatus(response, 200, `GET ${BOOKMARKS}`);
  const listed = (await response.json()) as { items?: { url?: unknown }[] };
  return (listed.items ?? []).map((item) => String(item.url));
}

/** Every account of the instance (the list is unpaged), or undefined where the answer holds no list. */
async function listedAccounts(owner: APIRequestContext): Promise<unknown[] | undefined> {
  const response = await owner.get("/api/v1/instance/accounts");
  expectStatus(response, 200, "GET /api/v1/instance/accounts");
  const listed = (await response.json()) as { items?: unknown };
  return Array.isArray(listed.items) ? listed.items : undefined;
}

// One member for the whole file, so that the journey redeems one token and signs in once.
test.describe.serial("production defaults", () => {
  const token = randomBytes(4).toString("hex");
  const site = `https://production-defaults.example.test/${token}`;
  let member: Member | undefined;

  function signedIn(): Member {
    if (member === undefined) {
      throw new Error("the member was not provisioned before the journey");
    }
    return member;
  }

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    member = await provisionMember(playwright, token);
  });

  test.afterAll(async ({ playwright }) => {
    if (member !== undefined) {
      await removeMember(playwright, member);
    }
  });

  test("production defaults: a password sign-in sets a __Host- session cookie that is HttpOnly, Secure, SameSite=Lax and host-wide (T4)", () => {
    expect(sessionCookieViolations(signedIn().signInCookies)).toEqual([]);
  });

  test("production defaults: a mutation with the session cookie is refused unless it comes from the app, as JSON, and a bearer token is not bound to the origin (T5)", async ({ playwright }) => {
    const { session } = signedIn();
    const refused: string[] = [];
    const refuse = async (label: string, mutate: (url: string) => Promise<APIResponse>): Promise<void> => {
      const url = `${site}/refused/${String(refused.length)}`;
      refused.push(url);
      expect(crossSiteRefusalViolations(label, await answerOf(await mutate(url))), label).toEqual([]);
    };
    const body = (url: string, title: string): Record<string, string> => ({ url, title: `${title} ${token}` });

    await refuse("another origin", (url) =>
      session.post(BOOKMARKS, { headers: { origin: "https://other.example.test", "content-type": "application/json" }, data: body(url, "Other origin") }),
    );
    await refuse("no Origin", (url) => session.post(BOOKMARKS, { headers: { "content-type": "application/json" }, data: body(url, "No origin") }));
    await refuse("Sec-Fetch-Site cross-site and the right Origin", (url) =>
      session.post(BOOKMARKS, { headers: { ...SAME_ORIGIN, "sec-fetch-site": "cross-site" }, data: body(url, "Cross-site fetch") }),
    );
    await refuse("a text/plain content type", (url) =>
      session.post(BOOKMARKS, { headers: { origin: appOrigin(), "content-type": "text/plain" }, data: JSON.stringify(body(url, "Plain text")) }),
    );

    const allowed = `${site}/allowed`;
    const created = await session.post(BOOKMARKS, json(body(allowed, "Same origin")));
    expect(processedViolations("the right Origin, Sec-Fetch-Site same-origin and JSON", await answerOf(created), 201)).toEqual([]);

    // A bearer token carries no ambient credential, so a foreign Origin does not matter to it.
    // Creating a token needs a recent confirmation of the password (doc 04 section 4.4).
    expectStatus(await session.post("/api/v1/me/reauth", json({ password: signedIn().password })), 204, "POST /api/v1/me/reauth");
    const made = await session.post("/api/v1/me/api-tokens", json({ name: `Defaults ${token}`, scope: "read-write" }));
    expectStatus(made, 201, "POST /api/v1/me/api-tokens");
    const apiToken = ((await made.json()) as { token?: unknown }).token;
    if (typeof apiToken !== "string" || apiToken === "") {
      throw new Error("POST /api/v1/me/api-tokens answered without a token");
    }
    const bearer = await playwright.request.newContext({ ...options(), storageState: NO_SESSION });
    const viaToken = `${site}/bearer`;
    try {
      const processed = await bearer.post(BOOKMARKS, {
        headers: { origin: "https://other.example.test", "content-type": "application/json", authorization: `Bearer ${apiToken}` },
        data: body(viaToken, "Bearer"),
      });
      expect(processedViolations("a bearer token and another origin", await answerOf(processed), 201)).toEqual([]);
    } finally {
      await bearer.dispose();
    }

    // The session cookie is ignored once an Authorization header is present: a token that is not valid is a 401, not the session's account.
    const notValid = `${site}/not-valid`;
    refused.push(notValid);
    const stale = await session.post(BOOKMARKS, {
      headers: { ...SAME_ORIGIN, authorization: `Bearer ${randomBytes(24).toString("base64url")}` },
      data: body(notValid, "Not valid"),
    });
    expect(unauthenticatedViolations("a bearer token that is not valid and the session cookie", await answerOf(stale))).toEqual([]);

    // Nothing the refused requests asked for was written; what was processed is there.
    const listed = await bookmarkUrls(signedIn());
    expect(leakedBookmarks(refused, listed)).toEqual([]);
    expect(listed, "the processed requests wrote their bookmarks").toEqual(expect.arrayContaining([allowed, viaToken]));
  });

  test("production defaults: the app, the API and /go carry the security headers, and the API and /go are not cached (T5, T14)", async ({ playwright }) => {
    const { session } = signedIn();
    const visitor = await playwright.request.newContext({ ...options(), storageState: NO_SESSION });
    try {
      const page = await visitor.get("/", { headers: { accept: "text/html" } });
      expectStatus(page, 200, "GET /");
      expect(page.headers()["content-type"] ?? "", "the content type of /").toContain("text/html");
      expect(securityHeaderViolations(page.headers()), "the HTML of /").toEqual([]);

      const me = await session.get("/api/v1/me");
      expectStatus(me, 200, "GET /api/v1/me");
      expect(securityHeaderViolations(me.headers()), "GET /api/v1/me").toEqual([]);
      expect(noStoreViolations(me.headers()), "GET /api/v1/me").toEqual([]);

      const problem = await visitor.get("/api/v1/me");
      expectStatus(problem, 401, "GET /api/v1/me without a session");
      expect(problem.headers()["content-type"] ?? "", "the content type of the problem answer").toContain("application/problem+json");
      expect(securityHeaderViolations(problem.headers()), "the problem answer").toEqual([]);
      expect(noStoreViolations(problem.headers()), "the problem answer").toEqual([]);

      const slug = `pd-${token}`;
      const destination = `${site}/destination`;
      expectStatus(await session.post(BOOKMARKS, json({ url: destination, title: `Forward ${token}`, slug, forwarding: true })), 201, `POST ${BOOKMARKS}`);
      const go = await session.get(`/go/${slug}`, { maxRedirects: 0 });
      expectStatus(go, 302, `GET /go/${slug}`);
      expect(go.headers().location, "where /go forwards").toBe(destination);
      expect(goHeaderViolations(go.headers()), "the /go answer").toEqual([]);
      expect(securityHeaderViolations(go.headers()), "the /go answer").toEqual([]);
    } finally {
      await visitor.dispose();
    }
  });

  test("production defaults: the probes disclose liveness and the build only, and set no cookie (T22)", async ({ playwright }) => {
    const visitor = await playwright.request.newContext({ ...options(), storageState: NO_SESSION });
    try {
      expect(healthViolations(await answerOf(await visitor.get("/health")))).toEqual([]);
      expect(versionViolations(await answerOf(await visitor.get("/version")))).toEqual([]);
    } finally {
      await visitor.dispose();
    }
  });

  test("production defaults: the setup endpoint is closed once the first account exists (doc 10 section 2.1)", async ({ playwright }) => {
    const owner = await playwright.request.newContext({ ...options(), storageState: STORAGE_STATE });
    const visitor = await playwright.request.newContext({ ...options(), storageState: NO_SESSION });
    try {
      const email = `setup-${token}@example.test`;
      const refused = await visitor.post(
        "/api/v1/setup",
        json({
          displayName: `Setup ${token}`,
          email,
          password: randomBytes(24).toString("base64url"),
          workspaceName: `Setup ${token}`,
          setupToken: process.env.E2E_SETUP_TOKEN ?? randomBytes(24).toString("base64url"),
        }),
      );
      expect(setupClosedViolations(await answerOf(refused))).toEqual([]);
      expect(leakedAccounts(await listedAccounts(owner), email)).toEqual([]);
    } finally {
      await owner.dispose();
      await visitor.dispose();
    }
  });
});
