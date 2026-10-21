import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount } from "../auth/support.ts";
import { recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, bearer, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /instance/accounts and PATCH /instance/accounts/{id} through the whole chain over the migrated database (doc 04
// section 10.10, doc 02 sections 2.3 and 11.2, doc 10 T4 and T18). The failure scenarios: a caller the instanceAdmin
// policy excludes that lists or changes an account; a list that carries a hash, a secret or anything a workspace
// holds; a disabled account whose existing session or API token still works on its next request, or that sees anything
// but the generic sign-in error; a change of the flag that leaves the target's old session alive; the last enabled
// admin demoted or disabled; and a change that skips the re-authentication or writes an event or sends a mail when
// it is refused or changes nothing.

const ACCOUNTS = "/api/v1/instance/accounts";
const LOGIN = "/api/v1/auth/login";
const ME = "/api/v1/me";
const WORKSPACE = "/api/v1/workspace";
const MAIL_JOB = "mail.send";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
  // The accounts a test counts as admins are the ones it makes.
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
});

const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

/** What another admin's demotion of the caller does, committed while the caller's request is in flight. */
async function loseFlag(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE id = ${accountId}`;
  });
}

async function enrolSecondFactor(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${accountId}`;
  });
}

interface Caller {
  readonly accountId: string;
  readonly email: string;
  readonly cookie: string;
}

/** A signed-in account with the flag and the second factor the options give, that has not re-authenticated. */
async function caller(world: World, options: { flag: boolean; mfa: boolean }): Promise<Caller> {
  const account = await seedAccount(database(), { emailVerified: true, instanceAdmin: options.flag });
  const response = await send(world, "POST", LOGIN, {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  if (options.mfa) {
    await enrolSecondFactor(account.id);
  }
  return { accountId: account.id, email: account.email, cookie: `${SESSION_COOKIE}=${token}` };
}

/** An instance admin with a second factor whose session re-authenticated just now. */
async function admin(world: World): Promise<Caller & { readonly person: Person }> {
  const person = await harness.person(world);
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
  });
  await enrolSecondFactor(person.account.id);
  return { accountId: person.account.id, email: person.account.email, cookie: person.cookie, person };
}

interface EventRow {
  actor_account_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function instanceEvents(): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`SELECT actor_account_id, action, entity_type, entity_id, metadata FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`;
  });
  return [...rows];
}

async function mailJobs(): Promise<Record<string, unknown>[]> {
  return (await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${MAIL_JOB} ORDER BY created_on`).map((row) => row.data);
}

interface Listed {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly isInstanceAdmin: boolean;
  readonly disabled: boolean;
  readonly lastSignInAt: string | null;
  readonly workspaceCount: number;
}

const patch = (world: World, as: { cookie: string }, id: string, body: unknown): Promise<Response> => send(world, "PATCH", `${ACCOUNTS}/${id}`, { cookie: as.cookie }, body);

const withoutRequestId = (problem: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(problem as Record<string, unknown>).filter(([key]) => key !== "requestId"));

const statusOf = async (world: World, cookie: string): Promise<number> => (await send(world, "GET", ME, { cookie })).status;

describe("GET /instance/accounts", () => {
  it("lists every account with its state and nothing secret or held by a workspace, and writes one instance audit event", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    await enrolSecondFactor(owner.account.id);
    const before = (await instanceEvents()).filter((event) => event.action === "instance.accounts_viewed").length;

    const response = await send(world, "GET", ACCOUNTS, { cookie: root.cookie });

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { items: Listed[] };
    expect(Object.keys(body)).toEqual(["items"]);
    expect(body.items.find((item) => item.id === owner.account.id)).toEqual({
      id: owner.account.id,
      displayName: "Test account",
      email: owner.account.email,
      emailVerified: true,
      mfaEnabled: true,
      isInstanceAdmin: false,
      disabled: false,
      lastSignInAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as string,
      workspaceCount: 1,
    });
    expect(body.items.find((item) => item.id === root.accountId)).toMatchObject({ isInstanceAdmin: true, mfaEnabled: true });
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(["disabled", "displayName", "email", "emailVerified", "id", "isInstanceAdmin", "lastSignInAt", "mfaEnabled", "workspaceCount"]);
    }
    expect(text).not.toMatch(/argon2|password|secret|sealed/i);
    expect(text).not.toContain(workspaceId);
    const events = (await instanceEvents()).filter((event) => event.action === "instance.accounts_viewed");
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({ actor_account_id: root.accountId, action: "instance.accounts_viewed", entity_type: null, entity_id: null, metadata: {} });
  });
});

describe("PATCH /instance/accounts/{id} disabling and enabling", () => {
  it("disables the account: its existing session and its API token stop working on their next request, it sees the generic sign-in error, and the event names it", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: target, role: "owner" }]);
    const token = await harness.token(workspaceId, target, "read-write");
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect((await send(world, "GET", WORKSPACE, bearer(token))).status).toBe(200);
    const wrong = await send(world, "POST", LOGIN, {}, { email: target.account.email, password: "not the password at all", remember: false });
    expect(wrong.status).toBe(401);
    const wrongBody = withoutRequestId(await wrong.json());

    const response = await patch(world, root, target.account.id, { disabled: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: target.account.id, disabled: true, isInstanceAdmin: false });
    expect(await statusOf(world, target.cookie)).toBe(401);
    const tokenAnswer = await send(world, "GET", WORKSPACE, bearer(token));
    expect(tokenAnswer.status).toBe(401);
    const signIn = await send(world, "POST", LOGIN, {}, { email: target.account.email, password: target.account.password, remember: false });
    expect(signIn.status).toBe(wrong.status);
    expect(withoutRequestId(await signIn.json())).toEqual(wrongBody);
    expect(signIn.headers.get("set-cookie")).toBeNull();
    expect((await instanceEvents()).at(-1)).toEqual({
      actor_account_id: root.accountId,
      action: "instance.account_disabled",
      entity_type: "account",
      entity_id: target.account.id,
      metadata: {},
    });
  });

  it("enables the account again: it can sign in and its token works, and the event says enabled", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: target, role: "owner" }]);
    const token = await harness.token(workspaceId, target, "read-write");
    expect((await patch(world, root, target.account.id, { disabled: true })).status).toBe(200);
    expect((await send(world, "GET", WORKSPACE, bearer(token))).status).toBe(401);

    const response = await patch(world, root, target.account.id, { disabled: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: target.account.id, disabled: false });
    // The old session is gone for good; the account signs in again, and its token, which was refused only while it was disabled, works.
    expect(await statusOf(world, target.cookie)).toBe(401);
    const signIn = await send(world, "POST", LOGIN, {}, { email: target.account.email, password: target.account.password, remember: false });
    expect(signIn.status).toBe(200);
    expect((await send(world, "GET", WORKSPACE, bearer(token))).status).toBe(200);
    expect((await instanceEvents()).at(-1)).toMatchObject({ actor_account_id: root.accountId, action: "instance.account_enabled", entity_id: target.account.id });
  });

  it("changes nothing for an account that already is in the state asked for: no event, no deleted session, no mail", async () => {
    const mail = new InMemoryMail();
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const enabled = await patch(world, root, target.account.id, { disabled: false, isInstanceAdmin: false });

    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ id: target.account.id, disabled: false, isInstanceAdmin: false });
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
    const disabled = await patch(world, root, target.account.id, { disabled: true });
    expect(disabled.status).toBe(200);
    expect((await mailJobs()).length).toBe(1);
    expect((await patch(world, root, target.account.id, { disabled: true })).status).toBe(200);
    expect((await mailJobs()).length).toBe(1);
  });

  it("queues the account-disabled mail with the account's identifier only when mail is configured and the state changed, and never when enabling", async () => {
    const world = harness.serve({ mail: new InMemoryMail() });
    const root = await admin(world);
    const target = await harness.person(world);

    expect((await patch(world, root, target.account.id, { disabled: true })).status).toBe(200);
    expect(await mailJobs()).toEqual([{ template: "accountDisabled", accountId: target.account.id }]);
    expect((await patch(world, root, target.account.id, { disabled: false })).status).toBe(200);
    expect(await mailJobs()).toHaveLength(1);
  });

  it("queues no mail where no mail adapter is configured, and still disables", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);

    const response = await patch(world, root, target.account.id, { disabled: true });

    expect(response.status).toBe(200);
    expect(await mailJobs()).toEqual([]);
    expect(await statusOf(world, target.cookie)).toBe(401);
  });
});

describe("PATCH /instance/accounts/{id} the instance-admin flag", () => {
  it("grants the flag and ends the target's sessions, so the privilege change cannot ride an old token", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    expect(await statusOf(world, target.cookie)).toBe(200);

    const response = await patch(world, root, target.account.id, { isInstanceAdmin: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: target.account.id, isInstanceAdmin: true, disabled: false });
    expect(await statusOf(world, target.cookie)).toBe(401);
    expect((await instanceEvents()).at(-1)).toEqual({
      actor_account_id: root.accountId,
      action: "instance.account_admin_granted",
      entity_type: "account",
      entity_id: target.account.id,
      metadata: {},
    });
  });

  it("clears the flag of another admin and ends that admin's sessions; that admin is refused the instance operations afterwards", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const other = await admin(world);

    const response = await patch(world, root, other.accountId, { isInstanceAdmin: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: other.accountId, isInstanceAdmin: false });
    expect(await statusOf(world, other.cookie)).toBe(401);
    expect((await instanceEvents()).at(-1)).toMatchObject({ actor_account_id: root.accountId, action: "instance.account_admin_revoked", entity_id: other.accountId });
  });

  it("applies the flag and the disabled state of one request together", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);

    const response = await patch(world, root, target.account.id, { isInstanceAdmin: true, disabled: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: target.account.id, isInstanceAdmin: true, disabled: true });
    expect((await instanceEvents()).slice(-2).map((event) => event.action)).toEqual(["instance.account_admin_granted", "instance.account_disabled"]);
  });

  it("answers 403 forbidden to a grant when the composition refuses it, and writes, ends and queues nothing; clearing and disabling are not its business", async () => {
    const asked: { accountId: string; targetAccountId: string }[] = [];
    const world = harness.serve({
      instanceAdminGrant: (subject) => {
        asked.push(subject);
        return false;
      },
    });
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, root, target.account.id, { isInstanceAdmin: true, disabled: true });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("forbidden");
    expect(asked).toEqual([{ accountId: root.accountId, targetAccountId: target.account.id }]);
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect((await patch(world, root, target.account.id, { isInstanceAdmin: false, disabled: true })).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  it("answers 403 forbidden and changes nothing, without logging an error, when the caller loses the flag after the policy admitted the request", async () => {
    const logger = recordingLogger();
    const asking: { accountId: string } = { accountId: "" };
    const world = harness.serve({
      logger,
      instanceAdminGrant: async () => {
        await loseFlag(asking.accountId);
        return true;
      },
    });
    const root = await admin(world);
    asking.accountId = root.accountId;
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, root, target.account.id, { isInstanceAdmin: true });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("forbidden");
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
    expect([...logger.entries, ...logger.requests].filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("answers 500, not a grant, when the composition's check throws", async () => {
    const world = harness.serve({
      instanceAdminGrant: () => {
        throw new Error("the check is down");
      },
    });
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, root, target.account.id, { isInstanceAdmin: true });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await instanceEvents()).toEqual(events);
    expect(await statusOf(world, target.cookie)).toBe(200);
  });
});

describe("PATCH /instance/accounts/{id} the last admin", () => {
  it("answers 422 validation_failed with the field code last_instance_admin when the only admin clears their own flag, and changes nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const events = await instanceEvents();

    const response = await patch(world, root, root.accountId, { isInstanceAdmin: false });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "isInstanceAdmin", code: "last_instance_admin" }] });
    expect(await statusOf(world, root.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
  });

  it("answers 422 last_instance_admin on disabled when the only admin disables themselves, and keeps their session", async () => {
    const world = harness.serve({ mail: new InMemoryMail() });
    const root = await admin(world);
    const events = await instanceEvents();

    const response = await patch(world, root, root.accountId, { disabled: true });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "disabled", code: "last_instance_admin" }] });
    expect(await statusOf(world, root.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it("refuses both fields of one request together when the first is refused, and applies neither", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const events = await instanceEvents();

    const response = await patch(world, root, root.accountId, { isInstanceAdmin: false, disabled: true });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: [{ path: "isInstanceAdmin", code: "last_instance_admin" }] });
    expect(await statusOf(world, root.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
  });

  it("does not count a disabled admin as another one", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const other = await admin(world);
    expect((await patch(world, root, other.accountId, { disabled: true })).status).toBe(200);

    const response = await patch(world, root, root.accountId, { isInstanceAdmin: false });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: [{ path: "isInstanceAdmin", code: "last_instance_admin" }] });
  });

  it("lets an admin clear their own flag while another enabled admin remains; their session then ends", async () => {
    const world = harness.serve();
    const root = await admin(world);
    await admin(world);

    const response = await patch(world, root, root.accountId, { isInstanceAdmin: false });

    expect(response.status).toBe(200);
    expect(await statusOf(world, root.cookie)).toBe(401);
  });

  it.each([
    [{ isInstanceAdmin: false, disabled: false }, false, ["instance.account_admin_revoked"]],
    [{ isInstanceAdmin: false, disabled: true }, true, ["instance.account_admin_revoked", "instance.account_disabled"]],
  ] as const)(
    "lets an admin who names the flag and the disabled state of their own account in one request, %j, change it while another enabled admin remains",
    async (body, disabled, actions) => {
      const world = harness.serve();
      const root = await admin(world);
      const other = await admin(world);
      const events = (await instanceEvents()).length;

      const response = await patch(world, root, root.accountId, body);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: root.accountId, isInstanceAdmin: false, disabled });
      expect((await instanceEvents()).slice(events).map((event) => [event.action, event.actor_account_id, event.entity_id])).toEqual(
        actions.map((action) => [action, root.accountId, root.accountId]),
      );
      expect(await statusOf(world, root.cookie)).toBe(401);
      expect(await statusOf(world, other.cookie)).toBe(200);
    },
  );
});

describe("PATCH /instance/accounts/{id} refusals", () => {
  it("answers 404 for an account that does not exist, writing and queuing nothing", async () => {
    const world = harness.serve({ mail: new InMemoryMail() });
    const root = await admin(world);
    const events = await instanceEvents();

    const response = await patch(world, root, "0192f3a0-aaaa-7000-8000-00000000dead", { disabled: true });

    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe("not_found");
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it.each([
    ["no field", {}],
    ["an unknown field", { disabled: true, passwordHash: "x" }],
    ["a verified address set to false", { emailVerified: false }],
    ["a verified address set to a string", { emailVerified: "true" }],
    ["a value of the wrong type", { isInstanceAdmin: "yes" }],
  ])("answers 422 for %s, changing nothing", async (_what, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, root, target.account.id, body);

    expect(response.status).toBe(422);
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
  });

  it("answers 401 reauth_required to a session that has not re-authenticated within ten minutes, and changes nothing", async () => {
    const world = harness.serve();
    const stale = await caller(world, { flag: true, mfa: true });
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, stale, target.account.id, { disabled: true });

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("reauth_required");
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("refuses everyone the instanceAdmin policy excludes, changing and reading nothing out", () => {
  const attempts = [
    ["GET", ACCOUNTS, undefined],
    ["PATCH", `${ACCOUNTS}/<id>`, { disabled: true }],
  ] as const;

  it.each(attempts)("answers 401 to %s %s without a credential", async (method, path, body) => {
    const world = harness.serve();
    const target = await harness.person(world);

    const response = await send(world, method, path.replace("<id>", target.account.id), {}, body);

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("unauthenticated");
    expect(await statusOf(world, target.cookie)).toBe(200);
  });

  it.each(attempts)("answers 403 forbidden to %s %s from an account that holds no flag, even with a second factor and a fresh re-authentication", async (method, path, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const ordinary = await harness.person(world);
    await enrolSecondFactor(ordinary.account.id);
    const events = await instanceEvents();

    const response = await send(world, method, path.replace("<id>", target.account.id), { cookie: ordinary.cookie }, body);

    expect(response.status).toBe(403);
    const text = await response.text();
    expect((JSON.parse(text) as { code: string }).code).toBe("forbidden");
    expect(text).not.toContain(root.email);
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
  });

  it.each(attempts)("answers 403 forbidden to %s %s from an instance admin who has no second factor enrolled", async (method, path, body) => {
    const world = harness.serve();
    const person = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
    });
    const target = await harness.person(world);

    const response = await send(world, method, path.replace("<id>", target.account.id), { cookie: person.cookie }, body);

    expect(response.status).toBe(403);
    expect(await statusOf(world, target.cookie)).toBe(200);
  });

  it.each(attempts)("answers 403 forbidden to %s %s with an API token, even of an admin with a second factor", async (method, path, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const { workspaceId } = await harness.workspaceOf([{ person: root.person, role: "owner" }]);
    const value = await harness.token(workspaceId, root.person, "read-write");
    const target = await harness.person(world);

    const response = await send(world, method, path.replace("<id>", target.account.id), bearer(value), body);

    expect(response.status).toBe(403);
    expect(await statusOf(world, target.cookie)).toBe(200);
  });

  it("answers 403 to PATCH from another origin", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);

    const response = await send(world, "PATCH", `${ACCOUNTS}/${target.account.id}`, { cookie: root.cookie, origin: "https://evil.example" }, { disabled: true });

    expect(response.status).toBe(403);
    expect(await statusOf(world, target.cookie)).toBe(200);
  });
});
