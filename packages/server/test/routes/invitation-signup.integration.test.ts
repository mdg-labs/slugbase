import { hashCredentialToken } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { HookResult } from "../../src/hooks/index.ts";
import type { ServerModule } from "../../src/create-server.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/invitations/accept with registration fields through the whole chain over the migrated database
// (doc 02 sections 2.2 and 3.4, doc 04 sections 3.2 and 10.5, doc 05 section 3.3, doc 01 section 13.5, doc 10 T8 and
// T19). The failure scenarios: two accepts of one token that create two accounts or two memberships; a weak or breached
// password that uses up the invitation; an account made for an address other than the invited one; an address that
// has an account and is answered with one made over it; a refusal of the registration policy that writes anything or
// tells an address that has an account from one that has none; a half-created account (no session, no membership, an
// unverified address, a personal workspace).

const INVITATIONS = "/api/v1/invitations";
const ACCEPT = `${INVITATIONS}/accept`;
const TEST_TIMEOUT_MS = 60_000;
const PASSWORD = "correct horse battery staple 42";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
});

afterAll(() => harness.stop());

interface Problem {
  readonly status: number;
  readonly code: string;
  readonly errors?: { path: string; code: string }[];
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

function serve(options: { env?: Record<string, string>; modules?: readonly ServerModule[] } = {}): World {
  return harness.serve({
    entitlements: GRANTED,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", ...options.env },
  });
}

/** A policy that records what it is asked and answers by the address. */
function policy(decide: (email: string) => boolean): { module: ServerModule; seen: { email: string; path: string }[] } {
  const seen: { email: string; path: string }[] = [];
  return {
    seen,
    module: {
      name: "policy",
      hooks: {
        registrationPolicy: (input) => {
          seen.push({ email: input.email, path: input.path });
          return decide(input.email) ? HookResult.allow() : HookResult.refuse("blocked_domain");
        },
      },
      register: () => ({}),
    },
  };
}

async function workspace(world: World) {
  const o = await harness.person(world);
  const a = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: o, role: "owner" },
    { person: a, role: "admin" },
  ]);
  return { workspaceId, o, a };
}

interface Issued {
  readonly id: string;
  readonly token: string;
}

async function invite(world: World, admin: Person, email: string, role: "admin" | "member" = "member"): Promise<Issued> {
  const created = await send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email, role });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const response = await send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: admin.cookie });
  expect(response.status).toBe(200);
  const { link } = (await response.json()) as { link: string };
  const token = new URL(link).pathname.split("/").at(-1);
  if (token === undefined || hashCredentialToken(token) === undefined) {
    throw new Error("the link carries no token");
  }
  return { id, token };
}

const signup = (world: World, token: string, fields: Record<string, unknown> = { displayName: "Grace Hopper", password: PASSWORD }, headers: Record<string, string> = {}): Promise<Response> =>
  send(world, "POST", ACCEPT, headers, { token, ...fields });

function cookieOf(response: Response): string {
  const value = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (value === undefined) {
    throw new Error("the response sets no session cookie");
  }
  return `${SESSION_COOKIE}=${value}`;
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: Date | null;
  password_hash: string | null;
}

async function accountsWithEmail(email: string): Promise<AccountRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`SELECT id, email, display_name, email_verified_at, password_hash FROM accounts WHERE email = ${email}`;
  });
  return [...rows];
}

async function invitationStatus(id: string): Promise<{ status: string; accepted_by: string | null }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ status: string; accepted_by: string | null }[]>`SELECT status, accepted_by FROM workspace_invitations WHERE id = ${id}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

async function jobsNamed(name: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
  return [...(await database().app<{ id: string; data: Record<string, unknown> }[]>`SELECT id, data FROM pgboss.job WHERE name = ${name}`)];
}

async function joinedAudit(workspaceId: string): Promise<{ actor_account_id: string; metadata: Record<string, string>; actor_label: string }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ actor_account_id: string; metadata: Record<string, string>; actor_label: string }[]>`
      SELECT actor_account_id, metadata, actor_label FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'member.joined'`;
  });
  return [...rows];
}

describe("POST /api/v1/invitations/accept with a display name and a password", { timeout: TEST_TIMEOUT_MS }, () => {
  it("creates the verified account of the invited address even where verification is required, makes it a member with the invited role, signs it in with the workspace active, and makes no personal workspace", async () => {
    const world = serve({ env: { EMAIL_VERIFICATION_REQUIRED: "true" } });
    const { workspaceId, o, a } = await workspace(world);
    const { id, token } = await invite(world, a, "New.Person@Example.test", "admin");

    const created = await signup(world, token, { displayName: "  Grace Hopper  ", password: PASSWORD });

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ workspaceId, role: "admin" });
    const setCookie = created.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; `));
    expect(setCookie).toContain("HttpOnly");
    const accounts = await accountsWithEmail("new.person@example.test");
    expect(accounts).toHaveLength(1);
    const account = accounts[0];
    expect(account).toMatchObject({ email: "New.Person@Example.test", display_name: "Grace Hopper" });
    expect(account?.email_verified_at).toBeInstanceOf(Date);
    expect(account?.password_hash).toMatch(/^\$argon2id\$/);
    expect(await invitationStatus(id)).toEqual({ status: "accepted", accepted_by: account?.id });
    expect(await harness.rolesOf(workspaceId)).toEqual({ [o.account.id]: "owner", [a.account.id]: "admin", [account?.id ?? ""]: "admin" });

    const cookie = cookieOf(created);
    const me = await send(world, "GET", "/api/v1/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      account: { id: account?.id, email: "New.Person@Example.test", emailVerified: true, hasPassword: true },
      activeWorkspaceId: workspaceId,
      memberships: [{ workspaceId, role: "admin" }],
    });
    const current = await send(world, "GET", "/api/v1/workspace", { cookie });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ id: workspaceId, role: "admin" });
    const workspaces = await send(world, "GET", "/api/v1/workspaces", { cookie });
    expect(((await workspaces.json()) as { items: unknown[] }).items).toHaveLength(1);
    const login = await send(world, "POST", "/api/v1/auth/login", {}, { email: "new.person@example.test", password: PASSWORD, remember: false });
    expect(login.status).toBe(200);

    expect(await joinedAudit(workspaceId)).toEqual([
      { actor_account_id: account?.id, actor_label: "Grace Hopper", metadata: { role: "admin" } },
    ]);
    const createdJobs = await jobsNamed("event.account.created");
    expect(createdJobs.map((job) => job.data)).toEqual([{ eventId: createdJobs[0]?.id, accountId: account?.id, path: "invitation" }]);
    const joinedJobs = await jobsNamed("event.member.joined");
    expect(joinedJobs.map((job) => job.data)).toEqual([{ eventId: joinedJobs[0]?.id, workspaceId, accountId: account?.id, role: "admin" }]);
    expect(await jobsNamed("mail.send")).toEqual([]);
    for (const job of [...createdJobs, ...joinedJobs]) {
      expect(JSON.stringify(job.data)).not.toContain(token);
      expect(JSON.stringify(job.data)).not.toContain(PASSWORD);
    }
  });

  it("creates one account and one membership when parallel requests carry one token, and answers token_expired to the rest", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const { id, token } = await invite(world, a, "racer@example.test");

    const answers = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => signup(world, token, { displayName: `Racer ${String(index)}`, password: `${PASSWORD} ${String(index)}` })),
    );

    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 410)).toHaveLength(5);
    for (const refused of answers.filter((answer) => answer.status === 410)) {
      expect((await problemOf(refused)).code).toBe("token_expired");
    }
    expect(await accountsWithEmail("racer@example.test")).toHaveLength(1);
    expect(Object.keys(await harness.rolesOf(workspaceId))).toHaveLength(3);
    expect((await invitationStatus(id)).status).toBe("accepted");
    expect(await joinedAudit(workspaceId)).toHaveLength(1);
    expect(await jobsNamed("event.account.created")).toHaveLength(1);
    expect(await jobsNamed("event.member.joined")).toHaveLength(1);
    expect((await signup(world, token)).status).toBe(410);
  });

  it("leaves the invitation usable after a password the policy refuses, for a short one and a breached one", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const { id, token } = await invite(world, a, "weak@example.test");

    for (const [password, code] of [
      ["short", "too_short"],
      ["password1234", "breached"],
    ] as const) {
      const refused = await signup(world, token, { displayName: "Weak", password });
      expect(refused.status).toBe(422);
      const problem = await problemOf(refused);
      expect(problem.code).toBe("weak_password");
      expect(problem.errors).toContainEqual({ path: "password", code });
    }

    expect(await accountsWithEmail("weak@example.test")).toEqual([]);
    expect(await invitationStatus(id)).toEqual({ status: "pending", accepted_by: null });
    expect(Object.keys(await harness.rolesOf(workspaceId))).toHaveLength(2);
    expect(await jobsNamed("event.account.created")).toEqual([]);

    expect((await signup(world, token)).status).toBe(201);
  });

  it("makes the account of the address the invitation names, never one the request names: a forwarded link cannot be redeemed for another address", async () => {
    const world = serve();
    const { a } = await workspace(world);
    const { token } = await invite(world, a, "invited@example.test");

    const named = await signup(world, token, { displayName: "Mallory", password: PASSWORD, email: "mallory@example.test" });
    expect(named.status).toBe(422);
    expect(await accountsWithEmail("mallory@example.test")).toEqual([]);

    expect((await signup(world, token, { displayName: "Mallory", password: PASSWORD })).status).toBe(201);
    expect(await accountsWithEmail("invited@example.test")).toHaveLength(1);
    expect(await accountsWithEmail("mallory@example.test")).toEqual([]);
  });

  it("answers 409 email_taken for an address that has an account, creating nothing and leaving the invitation for that account to accept", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const holder = await harness.person(world);
    const { id, token } = await invite(world, a, holder.account.email.toUpperCase());
    const before = await harness.rolesOf(workspaceId);

    const refused = await signup(world, token);

    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("email_taken");
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await harness.rolesOf(workspaceId)).toEqual(before);
    expect(await invitationStatus(id)).toEqual({ status: "pending", accepted_by: null });
    expect(await jobsNamed("event.account.created")).toEqual([]);
    expect(await joinedAudit(workspaceId)).toEqual([]);
    const accepted = await send(world, "POST", ACCEPT, { cookie: holder.cookie }, { token });
    expect(accepted.status).toBe(200);
    expect((await harness.rolesOf(workspaceId))[holder.account.id]).toBe("member");
  });

  it("asks the registration policy with the invited address and the path invitation before it reads whether the address has an account, and a refusal is 403 registration_refused for an address with or without an account, creating nothing and leaving the invitation usable", async () => {
    let allowed = false;
    const { module, seen } = policy(() => allowed);
    const world = serve({ modules: [module] });
    const { workspaceId, a } = await workspace(world);
    const holder = await harness.person(world);
    const taken = await invite(world, a, holder.account.email);
    const fresh = await invite(world, a, "Refused.Person@Example.test");
    const before = await harness.rolesOf(workspaceId);

    const refusedTaken = await signup(world, taken.token);
    const refusedFresh = await signup(world, fresh.token);

    for (const refused of [refusedTaken, refusedFresh]) {
      expect(refused.status).toBe(403);
      expect((await problemOf(refused)).code).toBe("registration_refused");
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    expect(seen).toEqual([
      { email: holder.account.email, path: "invitation" },
      { email: "Refused.Person@Example.test", path: "invitation" },
    ]);
    expect(await accountsWithEmail("refused.person@example.test")).toEqual([]);
    expect(await harness.rolesOf(workspaceId)).toEqual(before);
    expect(await invitationStatus(taken.id)).toEqual({ status: "pending", accepted_by: null });
    expect(await invitationStatus(fresh.id)).toEqual({ status: "pending", accepted_by: null });
    expect(await jobsNamed("event.account.created")).toEqual([]);

    allowed = true;
    expect((await signup(world, fresh.token)).status).toBe(201);
    expect((await signup(world, taken.token)).status).toBe(409);
  });

  it("is not asked, and refuses nothing, for a dead token: every kind of one answers the same 410 token_expired", async () => {
    const { module, seen } = policy(() => false);
    const world = serve({ modules: [module] });
    const { a } = await workspace(world);
    const revoked = await invite(world, a, "revoked@example.test");
    expect((await send(world, "DELETE", `${INVITATIONS}/${revoked.id}`, { cookie: a.cookie })).status).toBe(204);
    const unknown = Buffer.alloc(32, 7).toString("base64url");

    const answers = await Promise.all([unknown, "not-a-token", revoked.token].map(async (token) => problemOf(await signup(world, token))));

    for (const answer of answers) {
      expect(answer).toMatchObject({ status: 410, code: "token_expired" });
    }
    expect(seen).toEqual([]);
  });

  it("answers 503 unavailable and writes nothing when the policy hook fails", async () => {
    const world = serve({
      modules: [
        {
          name: "broken-policy",
          hooks: {
            registrationPolicy: () => {
              throw new Error("the policy service is down");
            },
          },
          register: () => ({}),
        },
      ],
    });
    const { a } = await workspace(world);
    const { id, token } = await invite(world, a, "hook@example.test");

    const answer = await signup(world, token);

    expect(answer.status).toBe(503);
    expect(await accountsWithEmail("hook@example.test")).toEqual([]);
    expect((await invitationStatus(id)).status).toBe("pending");
  });

  it("refuses a display name without a password and a password without a display name with 422, and a blank display name", async () => {
    const world = serve();
    const { a } = await workspace(world);
    const { id, token } = await invite(world, a, "partial@example.test");

    for (const fields of [{ displayName: "Grace" }, { password: PASSWORD }, { displayName: "   ", password: PASSWORD }]) {
      expect((await signup(world, token, fields)).status).toBe(422);
    }

    expect(await accountsWithEmail("partial@example.test")).toEqual([]);
    expect((await invitationStatus(id)).status).toBe("pending");
  });

  it("replaces the session cookie the request carried with the new account's session", async () => {
    const world = serve();
    const { a } = await workspace(world);
    const bystander = await harness.person(world);
    const { token } = await invite(world, a, "replacer@example.test");

    const created = await signup(world, token, { displayName: "Grace", password: PASSWORD }, { cookie: bystander.cookie });

    expect(created.status).toBe(201);
    expect((await send(world, "GET", "/api/v1/me", { cookie: bystander.cookie })).status).toBe(401);
    expect((await send(world, "GET", "/api/v1/me", { cookie: cookieOf(created) })).status).toBe(200);
  });

  it("counts every attempt against the token_redeem bucket of the client address", async () => {
    const world = serve({ env: { RATE_LIMIT_TOKEN_REDEEM_IP: "2/hour" } });
    const { a } = await workspace(world);
    const { token } = await invite(world, a, "limited@example.test");
    const unknown = Buffer.alloc(32, 9).toString("base64url");

    expect((await signup(world, unknown)).status).toBe(410);
    expect((await signup(world, unknown)).status).toBe(410);
    const limited = await signup(world, token);

    expect(limited.status).toBe(429);
    expect((await problemOf(limited)).code).toBe("rate_limited");
    expect(await accountsWithEmail("limited@example.test")).toEqual([]);
  });
});

describe("POST /api/v1/invitations/accept with the token alone, now that the operation is anonymous in the contract", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers 401 without a session and to an API token, writing nothing", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const person = await harness.person(world);
    const { id, token } = await invite(world, a, person.account.email);
    const apiToken = await harness.token(workspaceId, a, "read-write");

    const anonymous = await send(world, "POST", ACCEPT, {}, { token });
    const bearer = await send(world, "POST", ACCEPT, { authorization: `Bearer ${apiToken}` }, { token });

    for (const refused of [anonymous, bearer]) {
      expect(refused.status).toBe(401);
      expect((await problemOf(refused)).code).toBe("unauthenticated");
    }
    expect(await invitationStatus(id)).toEqual({ status: "pending", accepted_by: null });
    expect(await jobsNamed("event.member.joined")).toEqual([]);
  });

  it("still counts the signed-in account's acceptances against the per-account limit", async () => {
    const world = serve({ env: { RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "1/hour", TRUSTED_PROXY_HOPS: "1" } });
    const { a } = await workspace(world);
    const person = await harness.person(world);
    const { token } = await invite(world, a, person.account.email);
    const unknown = Buffer.alloc(32, 5).toString("base64url");
    const from = (address: string, value: string) => send(world, "POST", ACCEPT, { cookie: person.cookie, "x-forwarded-for": address }, { token: value });

    expect((await from("203.0.113.1", unknown)).status).toBe(410);
    const limited = await from("203.0.113.2", token);

    expect(limited.status).toBe(429);
    expect((await problemOf(limited)).code).toBe("rate_limited");
  });
});
