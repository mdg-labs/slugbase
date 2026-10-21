import { randomUUID } from "node:crypto";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HookResult, type DeletionGuardInput, type ServerHooks } from "../../src/hooks/index.ts";
import type { ServerModule } from "../../src/create-server.ts";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace } from "../auth/support.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, bearer, only, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// DELETE /api/v1/instance/accounts/{id} through the whole chain over the migrated database (doc 04 section 10.10, doc 02
// sections 2.10 and 11.2, doc 05 section 7.1, doc 01 section 13.2, doc 10 T1 and T18). The failure scenarios: a sole owner
// of a workspace that has other members who is deleted and leaves it without an owner; the last instance admin, alone or
// beside a disabled one, who is deleted; a refusing, failing or timing-out guard that leaves the account or any of its
// workspaces changed; a caller the instanceAdmin policy excludes, or a session that has not re-authenticated, who
// deletes; a row that still holds the account's address afterwards, or its identifier anywhere but in the one event that
// records the deletion; and another account's data that changes with it.

const ACCOUNTS = "/api/v1/instance/accounts";
const ME = "/api/v1/me";
const WORKSPACE = "/api/v1/workspace";
const LOGIN = "/api/v1/auth/login";
const JOB = "workspace.delete";
const ACCOUNT_EVENT = "event.account.deleted";
const SECRET = "sealed-totp-secret";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name IN (${JOB}, ${ACCOUNT_EVENT})`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
});

function guardModule(guard: NonNullable<ServerHooks["deletionGuard"]>): ServerModule {
  return { name: "test/billing", hooks: { deletionGuard: guard }, hookRefusals: { deletionGuard: ["billing_active"] }, register: () => ({}) };
}

async function enrolSecondFactor(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from(SECRET)}, mfa_secret_key_id = 'key-1', mfa_last_step = 7 WHERE id = ${accountId}`;
  });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO mfa_backup_codes (id, account_id, code_hash) VALUES (gen_random_uuid(), ${accountId}, ${Buffer.from("backup-hash")})`;
  });
}

/** An instance admin with a second factor whose session re-authenticated just now. */
async function admin(world: World, options: { readonly disabled?: boolean } = {}): Promise<Person> {
  const person = await harness.person(world);
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = true, disabled_at = ${options.disabled === true ? new Date() : null} WHERE id = ${person.account.id}`;
  });
  await enrolSecondFactor(person.account.id);
  return person;
}

type Role = "owner" | "admin" | "member";

/** A workspace with its settings row and the given members, every session of whom acts in it. */
async function workspaceOf(name: string, ...members: readonly (readonly [Person, Role])[]): Promise<string> {
  const workspaceId = await seedWorkspace(database(), { name });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
  });
  for (const [member, role] of members) {
    await seedMembership(database(), { workspaceId, accountId: member.account.id, role });
    for (const session of await sessionRows(database(), member.account.id)) {
      await setActiveWorkspace(database(), session.id, workspaceId);
    }
  }
  return workspaceId;
}

const remove = (world: World, as: { readonly cookie: string }, id: string): Promise<Response> => send(world, "DELETE", `${ACCOUNTS}/${id}`, { cookie: as.cookie });

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** One digest of every row of the tables a deletion can reach, as slugbase_system reads them: a change anywhere shows. */
async function state(): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(a::text, '|' ORDER BY a.id) FROM accounts a), '') ||
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w), '') ||
        coalesce((SELECT string_agg(m.workspace_id::text || m.account_id::text || m.role::text, '|' ORDER BY m.workspace_id, m.account_id) FROM workspace_members m), '') ||
        coalesce((SELECT string_agg(s::text, '|' ORDER BY s.id) FROM sessions s), '') ||
        coalesce((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM api_tokens t), '') ||
        coalesce((SELECT string_agg(c::text, '|' ORDER BY c.id) FROM mfa_backup_codes c), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e), '')
      ) AS digest`;
  });
  const queued = await database().owner<{ digest: string }[]>`
    SELECT md5(coalesce(string_agg(j.name || j.data::text, '|' ORDER BY j.id), '')) AS digest FROM pgboss.job j WHERE j.name IN (${JOB}, ${ACCOUNT_EVENT})`;
  return `${only(rows, 0).digest}:${only(queued, 0).digest}`;
}

async function instanceAdmins(): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM accounts WHERE is_instance_admin ORDER BY id`;
  });
  return rows.map((row) => row.id);
}

async function accountExists(accountId: string): Promise<boolean> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx`SELECT 1 FROM accounts WHERE id = ${accountId}`;
  });
  return rows.length === 1;
}

async function markedAt(workspaceId: string): Promise<Date | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ deleting_at: Date | null }[]>`SELECT deleting_at FROM workspaces WHERE id = ${workspaceId}`;
  });
  return only(rows, 0).deleting_at;
}

async function jobs(name: string): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

interface EventRow {
  id: string;
  actor_account_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  workspace_id: string | null;
}

/** The instance events that deleted one of `accountIds`, as slugbase_system reads them. */
async function deletionEvents(...accountIds: readonly string[]): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`
      SELECT id, actor_account_id, actor_label, action, entity_type, entity_id, metadata, workspace_id
      FROM audit_events WHERE action = 'instance.account_deleted' AND entity_id IN ${tx(accountIds)} ORDER BY created_at, id`;
  });
  return [...rows];
}

/** The audit rows with a column that holds `needle`, as slugbase_system reads them. */
async function eventsHolding(needle: string): Promise<{ id: string; action: string }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string; action: string }[]>`SELECT id, action FROM audit_events e WHERE to_jsonb(e)::text ILIKE ${`%${needle}%`}`;
  });
  return [...rows];
}

/** An earlier event of the catalog that names `target` as its target, made by `actor`. */
async function seedTargetEvent(workspaceId: string | null, actor: Person, action: string, target: string, metadata: Record<string, string>): Promise<string> {
  const id = randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata)
      VALUES (${id}, ${workspaceId}, 'account', ${actor.account.id}, 'Grace', ${action}, ${workspaceId === null ? "account" : "member"}, ${target}, ${JSON.stringify(metadata)}::text::jsonb)`;
  });
  return id;
}

describe("DELETE /api/v1/instance/accounts/{id}", () => {
  it("deletes the account: its sessions, tokens and sign-in are gone, its sole workspaces are hidden and queued, it leaves the shared ones, and its address is nowhere", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const ada = await harness.person(world);
    const grace = await harness.person(world);
    await enrolSecondFactor(ada.account.id);
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "admin"]);
    const adaToken = await seedApiToken(database(), { accountId: ada.account.id, workspaceId: own });
    const graceToken = await seedApiToken(database(), { accountId: grace.account.id, workspaceId: shared });
    const earlier = await seedTargetEvent(null, root, "instance.account_disabled", ada.account.id, {});
    const promoted = await seedTargetEvent(shared, grace, "member.role_changed", ada.account.id, { from: "member", to: "admin" });
    expect((await send(world, "GET", WORKSPACE, { cookie: ada.cookie })).status).toBe(200);

    const response = await remove(world, root, ada.account.id);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await accountExists(ada.account.id)).toBe(false);
    expect((await send(world, "GET", ME, { cookie: ada.cookie })).status).toBe(401);
    expect((await send(world, "GET", WORKSPACE, bearer(adaToken.value))).status).toBe(401);
    expect((await send(world, "POST", LOGIN, {}, { email: ada.account.email, password: ada.account.password, remember: false })).status).toBe(401);
    // her own workspace is marked and queued; the shared one keeps its owner and loses her
    expect(await markedAt(own)).toBeInstanceOf(Date);
    expect(await markedAt(shared)).toBeNull();
    expect(await jobs(JOB)).toEqual([{ workspaceId: own }]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([{ eventId: expect.any(String) as string, accountId: ada.account.id }]);
    // the other account, its session and token and the admin's keep working
    expect((await send(world, "GET", WORKSPACE, { cookie: grace.cookie })).status).toBe(200);
    expect((await send(world, "GET", WORKSPACE, bearer(graceToken.value))).status).toBe(200);
    expect((await send(world, "GET", ACCOUNTS, { cookie: root.cookie })).status).toBe(200);
    // no personal data of hers remains: the address is in no event, and her identifier only in the instance event that records the deletion
    expect(await eventsHolding(ada.account.email)).toEqual([]);
    const events = await deletionEvents(ada.account.id);
    expect(events).toEqual([
      {
        id: expect.any(String) as string,
        actor_account_id: root.account.id,
        actor_label: "Test account",
        action: "instance.account_deleted",
        entity_type: "account",
        entity_id: ada.account.id,
        metadata: {},
        workspace_id: null,
      },
    ]);
    expect((await eventsHolding(ada.account.id)).map((event) => event.id)).toEqual([only(events, 0).id]);
    const lost = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ id: string; entity_id: string | null }[]>`SELECT id, entity_id FROM audit_events WHERE id IN (${earlier}, ${promoted})`;
    });
    expect(lost.map((event) => event.entity_id)).toEqual([null, null]);
  });

  it("deletes a disabled account and another instance admin while an enabled admin remains", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const disabled = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${disabled.account.id}, true)`;
      await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled.account.id}`;
    });
    const other = await admin(world);

    expect((await remove(world, root, disabled.account.id)).status).toBe(204);
    expect((await remove(world, root, other.account.id)).status).toBe(204);

    expect(await instanceAdmins()).toEqual([root.account.id]);
    expect((await deletionEvents(disabled.account.id, other.account.id)).map((event) => event.entity_id).sort()).toEqual([disabled.account.id, other.account.id].sort());
  });

  it("answers 404 for an account that does not exist, and changes and writes nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const before = await state();

    const response = await remove(world, root, "0192f3a0-aaaa-7000-8000-00000000dead");

    expect(response.status).toBe(404);
    expect(await problem(response)).toMatchObject({ code: "not_found" });
    expect(await state()).toBe(before);
  });

  it("answers 400 or 422 for an identifier that is not one, and changes nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const before = await state();

    const response = await remove(world, root, "not-an-identifier");

    expect([400, 422]).toContain(response.status);
    expect(await state()).toBe(before);
  });
});

describe("DELETE /api/v1/instance/accounts/{id} while the account is the only owner of a workspace that has other members", () => {
  it("answers 409 last_owner naming each such workspace and no other, asks no guard and changes and writes nothing", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = harness.serve({ modules: [guardModule((input) => (asked.push(input), HookResult.allow()))] });
    const root = await admin(world);
    const ada = await harness.person(world);
    const grace = await harness.person(world);
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const team = await workspaceOf("Ada's team", [ada, "owner"], [grace, "member"]);
    const club = await workspaceOf("Ada's club", [ada, "owner"], [grace, "admin"]);
    await workspaceOf("Grace's with Ada", [grace, "owner"], [ada, "member"]);
    await workspaceOf("Co-owned", [grace, "owner"], [ada, "owner"]);
    const before = await state();

    const response = await remove(world, root, ada.account.id);

    expect(response.status).toBe(409);
    const body = await problem(response);
    expect(body).toMatchObject({ code: "last_owner", status: 409 });
    const listed = (body["workspaces"] as { id: string; name: string }[]).sort((a, b) => a.name.localeCompare(b.name));
    expect(listed).toEqual([
      { id: club, name: "Ada's club" },
      { id: team, name: "Ada's team" },
    ]);
    expect(listed.map((workspace) => workspace.id)).not.toContain(own);
    expect(await state()).toBe(before);
    expect(asked).toEqual([]);
    expect(await jobs(JOB)).toEqual([]);
    expect(await deletionEvents(ada.account.id)).toEqual([]);
    expect((await send(world, "GET", ME, { cookie: ada.cookie })).status).toBe(200);
  });

  it("lets the account go once the ownership is shared, and the workspace keeps an owner", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const ada = await harness.person(world);
    const grace = await harness.person(world);
    const team = await workspaceOf("Ada's team", [ada, "owner"], [grace, "member"]);
    expect((await remove(world, root, ada.account.id)).status).toBe(409);

    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ${team} AND account_id = ${grace.account.id}`;
    });

    expect((await remove(world, root, ada.account.id)).status).toBe(204);
    expect(await markedAt(team)).toBeNull();
    expect((await send(world, "GET", WORKSPACE, { cookie: grace.cookie })).status).toBe(200);
  });
});

describe("DELETE /api/v1/instance/accounts/{id} and the last instance admin", () => {
  it("answers 422 validation_failed with the field code last_instance_admin on id when the only admin asks for its own account, asks no guard and changes nothing", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = harness.serve({ modules: [guardModule((input) => (asked.push(input), HookResult.allow()))] });
    const root = await admin(world);
    const grace = await harness.person(world);
    await workspaceOf("Root's own", [root, "owner"]);
    await workspaceOf("Shared", [grace, "owner"], [root, "member"]);
    const before = await state();

    const response = await remove(world, root, root.account.id);

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "last_instance_admin" }] });
    expect(await state()).toBe(before);
    expect(await instanceAdmins()).toEqual([root.account.id]);
    expect(asked).toEqual([]);
    expect(await jobs(JOB)).toEqual([]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
    expect((await send(world, "GET", ME, { cookie: root.cookie })).status).toBe(200);
  });

  it("does not let a disabled admin make the enabled one deletable", async () => {
    const world = harness.serve();
    const root = await admin(world);
    await admin(world, { disabled: true });
    const before = await state();

    const response = await remove(world, root, root.account.id);

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ errors: [{ path: "id", code: "last_instance_admin" }] });
    expect(await state()).toBe(before);
  });

  it("answers 422 with the field code self for the admin's own account while another enabled admin remains: that account is deleted with DELETE /me", async () => {
    const world = harness.serve();
    const root = await admin(world);
    await admin(world);
    const before = await state();

    const response = await remove(world, root, root.account.id);

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "self" }] });
    expect(await state()).toBe(before);
    expect(await accountExists(root.account.id)).toBe(true);
  });

  it("leaves one instance admin when two delete each other at once", async () => {
    const world = harness.serve();
    const ada = await admin(world);
    const grace = await admin(world);
    await workspaceOf("Ada's own", [ada, "owner"]);
    await workspaceOf("Grace's own", [grace, "owner"]);

    const statuses = (await Promise.all([remove(world, ada, grace.account.id), remove(world, grace, ada.account.id)])).map((response) => response.status).sort();

    // The loser's caller was deleted by the winner: the database refuses its call (403), or the winner's commit ended its session before the chain read it (401).
    expect(statuses[0]).toBe(204);
    expect([401, 403]).toContain(statuses[1]);
    expect(await instanceAdmins()).toHaveLength(1);
    expect(await accountExists(only(await instanceAdmins(), 0))).toBe(true);
  });

  it("leaves one instance admin when an admin deletes another while that one deletes its own account through DELETE /me", async () => {
    const world = harness.serve();
    const ada = await admin(world);
    const grace = await admin(world);

    const statuses = (
      await Promise.all([remove(world, ada, grace.account.id), send(world, "DELETE", ME, { cookie: grace.cookie }, { email: grace.account.email })])
    ).map((response) => response.status);

    // Either the admin's deletion wins and the account's own is answered 503 unavailable (its account is gone) or 401 (its session is gone),
    // or the account's own wins and the admin finds the account gone (404).
    expect(["204,503", "204,401", "404,204"]).toContain(statuses.join(","));
    expect(await instanceAdmins()).toEqual([ada.account.id]);
  });
});

describe("DELETE /api/v1/instance/accounts/{id} with a deletion guard", () => {
  it("asks the guard for the account and then for each workspace that goes with it, as the instance admin and naming the account that is deleted, and proceeds when it allows", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = harness.serve({ modules: [guardModule((input) => (asked.push(input), HookResult.allow()))] });
    const root = await admin(world);
    const ada = await harness.person(world);
    const first = await workspaceOf("First", [ada, "owner"]);
    const second = await workspaceOf("Second", [ada, "owner"]);

    expect((await remove(world, root, ada.account.id)).status).toBe(204);

    // the workspaces are asked in the order of their identifiers
    expect(first < second).toBe(true);
    expect(asked).toEqual([
      { kind: "account", accountId: ada.account.id, requestedBy: "instanceAdmin" },
      { kind: "workspace", workspaceId: first, accountId: ada.account.id, requestedBy: "instanceAdmin" },
      { kind: "workspace", workspaceId: second, accountId: ada.account.id, requestedBy: "instanceAdmin" },
    ]);
    expect(await accountExists(ada.account.id)).toBe(false);
  });

  it("answers 409 billing_active when the guard refuses the account, and changes and writes nothing", async () => {
    const world = harness.serve({ modules: [guardModule((input) => (input.kind === "account" ? HookResult.refuse("billing_active") : HookResult.allow()))] });
    const root = await admin(world);
    const ada = await harness.person(world);
    const grace = await harness.person(world);
    await workspaceOf("Ada's own", [ada, "owner"]);
    await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    const before = await state();

    const response = await remove(world, root, ada.account.id);

    expect(response.status).toBe(409);
    expect(await problem(response)).toMatchObject({ code: "billing_active" });
    expect(await state()).toBe(before);
    expect(await deletionEvents(ada.account.id)).toEqual([]);
    expect((await send(world, "GET", ME, { cookie: ada.cookie })).status).toBe(200);
  });

  it("answers 409 billing_active when the guard refuses the second workspace, and leaves the account and both workspaces untouched", async () => {
    let second = "";
    const world = harness.serve({
      modules: [guardModule((input) => (input.kind === "workspace" && input.workspaceId === second ? HookResult.refuse("billing_active") : HookResult.allow()))],
    });
    const root = await admin(world);
    const ada = await harness.person(world);
    const first = await workspaceOf("First", [ada, "owner"]);
    second = await workspaceOf("Second", [ada, "owner"]);
    expect(first < second).toBe(true);
    const before = await state();

    const response = await remove(world, root, ada.account.id);

    expect(response.status).toBe(409);
    expect(await problem(response)).toMatchObject({ code: "billing_active" });
    expect(await state()).toBe(before);
    expect(await markedAt(first)).toBeNull();
    expect(await markedAt(second)).toBeNull();
    expect(await jobs(JOB)).toEqual([]);
    expect(await deletionEvents(ada.account.id)).toEqual([]);
  });

  it("answers 503 unavailable when the guard throws, and changes and writes nothing", async () => {
    const world = harness.serve({
      modules: [
        guardModule(() => {
          throw new Error("the billing service is down");
        }),
      ],
    });
    const root = await admin(world);
    const ada = await harness.person(world);
    await workspaceOf("Ada's own", [ada, "owner"]);
    const before = await state();

    const response = await remove(world, root, ada.account.id);

    expect(response.status).toBe(503);
    expect(await problem(response)).toMatchObject({ code: "unavailable" });
    expect(await state()).toBe(before);
    expect(await deletionEvents(ada.account.id)).toEqual([]);
  });
});

describe("DELETE /api/v1/instance/accounts/{id} is for the instance admin, with a fresh re-authentication", () => {
  it("answers 401 without a credential", async () => {
    const world = harness.serve();
    const target = await harness.person(world);
    const before = await state();

    const response = await send(world, "DELETE", `${ACCOUNTS}/${target.account.id}`, {});

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "unauthenticated" });
    expect(await state()).toBe(before);
  });

  it("answers 403 forbidden to an account that holds no flag, even with a second factor and a fresh re-authentication", async () => {
    const world = harness.serve();
    const target = await harness.person(world);
    const ordinary = await harness.person(world);
    await enrolSecondFactor(ordinary.account.id);
    const before = await state();

    const response = await remove(world, ordinary, target.account.id);

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "forbidden" });
    expect(await state()).toBe(before);
  });

  it("answers 403 forbidden to an instance admin who has no second factor enrolled", async () => {
    const world = harness.serve();
    const person = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
    });
    const target = await harness.person(world);
    const before = await state();

    expect((await remove(world, person, target.account.id)).status).toBe(403);
    expect(await state()).toBe(before);
  });

  it("answers 403 forbidden with an API token, even of an admin with a second factor", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const { workspaceId } = await harness.workspaceOf([{ person: root, role: "owner" }]);
    const value = await harness.token(workspaceId, root, "read-write");
    const target = await harness.person(world);

    const response = await send(world, "DELETE", `${ACCOUNTS}/${target.account.id}`, bearer(value));

    expect(response.status).toBe(403);
    expect(await accountExists(target.account.id)).toBe(true);
    expect(await deletionEvents(target.account.id)).toEqual([]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
  });

  it("answers 403 cross_site_request from another origin", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const before = await state();

    const response = await send(world, "DELETE", `${ACCOUNTS}/${target.account.id}`, { cookie: root.cookie, origin: "https://evil.example" });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "cross_site_request" });
    expect(await state()).toBe(before);
  });

  it("answers 401 reauth_required from a session that has not re-authenticated within ten minutes, and changes nothing", async () => {
    const world = harness.serve();
    const account = await seedAccount(database(), { emailVerified: true, instanceAdmin: true });
    const signedIn = await send(world, "POST", LOGIN, {}, { email: account.email, password: account.password, remember: false });
    const cookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
    await enrolSecondFactor(account.id);
    const target = await harness.person(world);
    const before = await state();

    const response = await send(world, "DELETE", `${ACCOUNTS}/${target.account.id}`, { cookie });

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect(await state()).toBe(before);
  });
});
