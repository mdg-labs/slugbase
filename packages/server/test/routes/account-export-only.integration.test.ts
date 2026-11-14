import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { archiveBookmarks, hashCredentialToken, type MailPort } from "@slugbase/core";
import { bookmarkArchiveTransaction } from "@slugbase/db";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { createWorker, type RunningWorker, type Worker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, bearer, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The export-only access mode through the whole chain over the migrated database (doc 02 sections 2.11 and 11.2, doc 04 sections 3.2 and 10.10, doc 05
// section 3.3, doc 10 T4 and T18): PUT /instance/accounts/{id}/access-mode, the check of stage 4 and the daily job that ends the period. The failure scenario:
// an account in the mode that creates a bookmark, accepts an invitation, calls the API with a token or opens /go/<slug> is refused, while GET of its bookmarks
// and both exports succeed, and after the end date the job deletes it (or disables it) and signing in fails with the generic error; a mode that is refused for
// an admin, a disabled account or a date less than a day ahead and leaves a trace; a request that changes nothing but writes an event or sends the mail again;
// a job that runs twice and acts twice, or that deletes an account that is the only owner of a workspace with other members.

const ACCOUNTS = "/api/v1/instance/accounts";
const BOOKMARKS = "/api/v1/bookmarks";
const INVITATIONS = "/api/v1/invitations";
const ME = "/api/v1/me";
const LOGIN = "/api/v1/auth/login";
const MAIL_JOB = "mail.send";
const JOB = "accounts.endAccessMode";
const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 90_000;
const WAIT_MS = 20_000;
const POLL_SECONDS = 0.5;
const SECRET = "sealed-totp-secret";
const SHELL = "<!doctype html><html><head><title>SlugBase shell</title></head><body><div id=\"root\"></div></body></html>";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
let webRoot: string;
let worker: RunningWorker | undefined;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "slugbase-export-only-"));
  writeFileSync(join(webRoot, "index.html"), SHELL);
  await harness.start();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
  inbox.clear();
});

afterAll(async () => {
  await harness.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
});

const serve = (): World => harness.serve({ mail, entitlements: GRANTED, webRoot });

async function admin(world: World): Promise<Person> {
  const person = await harness.person(world);
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
    await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from(SECRET)}, mfa_secret_key_id = 'key-1', mfa_last_step = 7 WHERE id = ${person.account.id}`;
  });
  return person;
}

interface EventRow {
  actor_account_id: string | null;
  actor_type: string;
  action: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function instanceEvents(): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`SELECT actor_account_id, actor_type, action, entity_id, metadata FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`;
  });
  return [...rows];
}

async function mailJobs(): Promise<Record<string, unknown>[]> {
  return (await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${MAIL_JOB} ORDER BY created_on`).map((row) => row.data);
}

interface Row {
  access_mode: string;
  export_only_until: Date | null;
  disabled_at: Date | null;
}

async function accountRow(id: string): Promise<Row | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Row[]>`SELECT access_mode, export_only_until, disabled_at FROM accounts WHERE id = ${id}`;
  });
  return rows[0];
}

/** Moves the end date of the period into the past, as slugbase_system, the way a period that ran its course looks. */
async function lapse(id: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET export_only_until = now() - interval '1 hour' WHERE id = ${id}`;
  });
}

const inDays = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

const setMode = (world: World, as: Person, id: string, body: unknown): Promise<Response> => send(world, "PUT", `${ACCOUNTS}/${id}/access-mode`, { cookie: as.cookie }, body);
const exportOnly = (days: number, endAction: "disable" | "delete" = "delete"): { mode: "exportOnly"; until: string; endAction: string } => ({ mode: "exportOnly", until: inDays(days), endAction });

async function problemOf(response: Response): Promise<{ code: string; status: number; until?: string; errors?: { path: string; code: string }[] }> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as { code: string; status: number; until?: string; errors?: { path: string; code: string }[] };
}

async function bookmarkCount(world: World, as: Person): Promise<number> {
  const response = await send(world, "GET", BOOKMARKS, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: unknown[] }).items.length;
}

/** A member who owns a workspace and a bookmark with the slug `docs` that forwards, with an API token of the workspace. */
async function member(world: World): Promise<{ person: Person; workspaceId: string; token: string }> {
  const person = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([{ person, role: "owner" }]);
  const created = await send(world, "POST", BOOKMARKS, { cookie: person.cookie }, { url: "https://example.com/docs", title: "Docs", slug: "docs", forwarding: true });
  expect(created.status).toBe(201);
  return { person, workspaceId, token: await harness.token(workspaceId, person, "read-write") };
}

function visit(world: World, path: string, cookie: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(path, world.origin), { method: "GET", headers: { accept: "text/html", cookie } }));
}

async function loginStatus(world: World, person: Person): Promise<number> {
  return (await send(world, "POST", LOGIN, {}, { email: person.account.email, password: person.account.password, remember: false })).status;
}

describe("PUT /instance/accounts/{id}/access-mode", () => {
  it(
    "leaves the account to read and export and nothing else: a bookmark, an invitation, a token request, /go and a profile change are refused with account_export_only",
    async () => {
      const world = serve();
      const root = await admin(world);
      const { person, workspaceId, token } = await member(world);
      const other = await harness.person(world);
      const { workspaceId: otherWorkspace } = await harness.workspaceOf([{ person: other, role: "owner" }]);
      const invited = await send(world, "POST", INVITATIONS, { cookie: other.cookie }, { email: person.account.email, role: "member", teamIds: [] });
      expect(invited.status).toBe(201);
      const invitationId = ((await invited.json()) as { id: string }).id;
      const link = (await (await send(world, "POST", `${INVITATIONS}/${invitationId}/link`, { cookie: other.cookie })).json()) as { link: string };
      const inviteToken = new URL(link.link).pathname.split("/").at(-1) ?? "";
      expect(hashCredentialToken(inviteToken)).toBeDefined();
      expect((await visit(world, "/go/docs", person.cookie)).status).toBe(302);
      expect((await send(world, "GET", BOOKMARKS, bearer(token))).status).toBe(200);
      await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;

      const until = inDays(3);
      const set = await setMode(world, root, person.account.id, { mode: "exportOnly", until, endAction: "delete" });

      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({ accessMode: "exportOnly", exportOnlyUntil: until, exportOnlyEndAction: "delete" });
      expect(await mailJobs()).toEqual([{ template: "exportOnly", accountId: person.account.id }]);
      const before = await bookmarkCount(world, person);
      expect(before).toBe(1);
      const me = (await (await send(world, "GET", ME, { cookie: person.cookie })).json()) as { account: { accessMode: string; exportOnlyUntil: string } };
      expect(me.account).toMatchObject({ accessMode: "exportOnly", exportOnlyUntil: until });
      expect((await send(world, "GET", "/api/v1/export/json", { cookie: person.cookie })).status).toBe(200);
      expect((await send(world, "GET", "/api/v1/export/netscape", { cookie: person.cookie })).status).toBe(200);
      expect((await send(world, "GET", "/api/v1/workspaces", { cookie: person.cookie })).status).toBe(200);
      expect(await loginStatus(world, person)).toBe(200);
      expect((await send(world, "GET", "/api/config", { cookie: person.cookie })).status).toBe(200);

      const refused: [string, Response][] = [
        ["a new bookmark", await send(world, "POST", BOOKMARKS, { cookie: person.cookie }, { url: "https://example.com/new", title: "New" })],
        ["a profile change", await send(world, "PATCH", ME, { cookie: person.cookie }, { displayName: "Changed" })],
        ["accepting an invitation", await send(world, "POST", `${INVITATIONS}/accept`, { cookie: person.cookie }, { token: inviteToken })],
        ["a bookmark read by token", await send(world, "GET", BOOKMARKS, bearer(token))],
        ["a token request to the profile", await send(world, "GET", ME, bearer(token))],
        ["the dashboard", await send(world, "GET", "/api/v1/dashboard", { cookie: person.cookie })],
        ["a new workspace", await send(world, "POST", "/api/v1/workspaces", { cookie: person.cookie }, { name: "Another" })],
        ["leaving the workspace", await send(world, "POST", "/api/v1/workspace/leave", { cookie: person.cookie }, { content: "transfer" })],
        ["a token created", await send(world, "POST", "/api/v1/me/api-tokens", { cookie: person.cookie }, { name: "x", workspaceId, scope: "read" })],
        ["the /go redirect", await visit(world, "/go/docs", person.cookie)],
      ];
      for (const [what, response] of refused) {
        expect(response.status, what).toBe(403);
        expect(await problemOf(response), what).toMatchObject({ code: "account_export_only", status: 403, until });
      }
      expect(await bookmarkCount(world, person)).toBe(before);
      const roles = await harness.rolesOf(otherWorkspace);
      expect(Object.keys(roles)).toEqual([other.account.id]);
      expect((await harness.rolesOf(workspaceId))[person.account.id]).toBe("owner");
      const name = (await (await send(world, "GET", ME, { cookie: person.cookie })).json()) as { account: { displayName: string } };
      expect(name.account.displayName).not.toBe("Changed");
    },
    TEST_TIMEOUT_MS,
  );

  it("lets a session list the account's plan-archived bookmarks, which the accounts whose plan ended hold, and still refuses a token of the account", async () => {
    const world = serve();
    const root = await admin(world);
    const { person, workspaceId, token } = await member(world);
    const archived = ((await (await send(world, "GET", BOOKMARKS, { cookie: person.cookie })).json()) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(archived).toHaveLength(1);
    await tenantDatabase(database()).withTenant({ accountId: person.account.id, workspaceId, requestId: "export-only-archive" }, async (tx) => {
      await archiveBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId, bookmarkIds: archived });
    });
    expect((await setMode(world, root, person.account.id, exportOnly(3))).status).toBe(200);

    const listed = await send(world, "GET", `${BOOKMARKS}/archived`, { cookie: person.cookie });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: archived[0], title: "Docs" }], total: 1 });
    const byToken = await send(world, "GET", `${BOOKMARKS}/archived`, bearer(token));
    expect(byToken.status).toBe(403);
    expect(await problemOf(byToken)).toMatchObject({ code: "account_export_only", status: 403 });
  }, TEST_TIMEOUT_MS);

  it("lets the account delete itself and sign out, which the period leaves to it, and does not refuse them as export-only", async () => {
    const world = serve();
    const root = await admin(world);
    const { person } = await member(world);
    expect((await setMode(world, root, person.account.id, exportOnly(3))).status).toBe(200);

    const wrongAddress = await send(world, "DELETE", ME, { cookie: person.cookie }, { email: "someone-else@example.test" });
    expect(wrongAddress.status).toBe(422);
    expect(await problemOf(wrongAddress)).toMatchObject({ code: "validation_failed", errors: [{ path: "email", code: "email_mismatch" }] });
    expect((await send(world, "POST", "/api/v1/auth/logout", { cookie: person.cookie })).status).toBe(204);
  }, TEST_TIMEOUT_MS);

  it("writes one event without content, names the end action and date, and answers a repeat of the same period without a second event or email", async () => {
    const world = serve();
    const root = await admin(world);
    const { person } = await member(world);
    const body = exportOnly(4, "disable");
    const eventsBefore = (await instanceEvents()).length;
    await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;

    expect((await setMode(world, root, person.account.id, body)).status).toBe(200);
    expect((await setMode(world, root, person.account.id, body)).status).toBe(200);

    const events = (await instanceEvents()).slice(eventsBefore);
    expect(events).toEqual([
      { actor_account_id: root.account.id, actor_type: "account", action: "instance.account_export_only_set", entity_id: person.account.id, metadata: { endAction: "disable", until: body.until.replace(/\.\d+Z$/, "Z") } },
    ]);
    expect(await mailJobs()).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("clears the mode: the account writes and its tokens work again, with one cleared event and no email", async () => {
    const world = serve();
    const root = await admin(world);
    const { person, token } = await member(world);
    expect((await setMode(world, root, person.account.id, exportOnly(3))).status).toBe(200);
    expect((await send(world, "GET", BOOKMARKS, bearer(token))).status).toBe(403);
    await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;

    const cleared = await setMode(world, root, person.account.id, { mode: "full" });

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ accessMode: "full", exportOnlyUntil: null, exportOnlyEndAction: null });
    expect(await mailJobs()).toEqual([]);
    expect((await send(world, "GET", BOOKMARKS, bearer(token))).status).toBe(200);
    expect((await send(world, "POST", BOOKMARKS, { cookie: person.cookie }, { url: "https://example.com/again", title: "Again" })).status).toBe(201);
    expect((await instanceEvents()).filter((event) => event.action === "instance.account_export_only_cleared" && event.entity_id === person.account.id)).toHaveLength(1);
    expect(await accountRow(person.account.id)).toMatchObject({ access_mode: "full", export_only_until: null });
  }, TEST_TIMEOUT_MS);

  it("queues no email where none is configured, and still sets the mode", async () => {
    const world = harness.serve({ webRoot });
    const root = await admin(world);
    const { person } = await member(world);
    expect((await setMode(world, root, person.account.id, exportOnly(3))).status).toBe(200);
    expect(await mailJobs()).toEqual([]);
    expect(await accountRow(person.account.id)).toMatchObject({ access_mode: "export_only" });
  }, TEST_TIMEOUT_MS);

  it("refuses a date less than a day ahead, an admin, a disabled account and a missing one, changing and writing nothing", async () => {
    const world = serve();
    const root = await admin(world);
    const { person } = await member(world);
    const other = await admin(world);
    const disabled = await harness.person(world);
    expect((await send(world, "PATCH", `${ACCOUNTS}/${disabled.account.id}`, { cookie: root.cookie }, { disabled: true })).status).toBe(200);
    await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
    const events = await instanceEvents();

    const tooSoon = await setMode(world, root, person.account.id, { mode: "exportOnly", until: new Date(Date.now() + DAY_MS - 5 * 60_000).toISOString(), endAction: "delete" });
    const ofAdmin = await setMode(world, root, other.account.id, exportOnly(3));
    const ofSelf = await setMode(world, root, root.account.id, exportOnly(3));
    const ofDisabled = await setMode(world, root, disabled.account.id, exportOnly(3));
    const missing = await setMode(world, root, "0192f3a0-aaaa-7000-8000-00000000dead", exportOnly(3));
    const malformed = await setMode(world, root, person.account.id, { mode: "exportOnly", endAction: "delete" });

    expect(tooSoon.status).toBe(422);
    expect(await problemOf(tooSoon)).toMatchObject({ code: "validation_failed", errors: [{ path: "until", code: "until_too_soon" }] });
    expect(ofAdmin.status).toBe(422);
    expect(await problemOf(ofAdmin)).toMatchObject({ errors: [{ path: "id", code: "instance_admin" }] });
    expect(ofSelf.status).toBe(422);
    expect(ofDisabled.status).toBe(422);
    expect(await problemOf(ofDisabled)).toMatchObject({ errors: [{ path: "id", code: "account_disabled" }] });
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(422);
    for (const id of [person.account.id, other.account.id, root.account.id, disabled.account.id]) {
      expect(await accountRow(id)).toMatchObject({ access_mode: "full", export_only_until: null });
    }
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("refuses to make an account in the period an instance admin, so the admin who keeps the instance stays one, and allows it once the period is cleared", async () => {
    const world = serve();
    const root = await admin(world);
    const { person } = await member(world);
    expect((await setMode(world, root, person.account.id, exportOnly(3))).status).toBe(200);
    const events = await instanceEvents();

    const promote = await send(world, "PATCH", `${ACCOUNTS}/${person.account.id}`, { cookie: root.cookie }, { isInstanceAdmin: true });

    expect(promote.status).toBe(422);
    expect(await problemOf(promote)).toMatchObject({ code: "validation_failed", errors: [{ path: "isInstanceAdmin", code: "export_only" }] });
    expect(await instanceEvents()).toEqual(events);
    const listed = (await (await send(world, "GET", ACCOUNTS, { cookie: root.cookie })).json()) as { items: { id: string; isInstanceAdmin: boolean; accessMode: string }[] };
    expect(listed.items.find((row) => row.id === person.account.id)).toMatchObject({ isInstanceAdmin: false, accessMode: "exportOnly" });

    expect((await setMode(world, root, person.account.id, { mode: "full" })).status).toBe(200);
    expect((await send(world, "PATCH", `${ACCOUNTS}/${person.account.id}`, { cookie: root.cookie }, { isInstanceAdmin: true })).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("refuses a caller the instanceAdmin policy excludes, an API token and a session whose re-authentication is stale", async () => {
    const world = serve();
    const root = await admin(world);
    const { person, token } = await member(world);
    const target = await harness.person(world);

    expect((await setMode(world, person, target.account.id, exportOnly(3))).status).toBe(403);
    expect((await send(world, "PUT", `${ACCOUNTS}/${target.account.id}/access-mode`, bearer(token), exportOnly(3))).status).toBe(403);
    expect((await send(world, "PUT", `${ACCOUNTS}/${target.account.id}/access-mode`, {}, exportOnly(3))).status).toBe(401);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE sessions SET reauth_at = now() - interval '11 minutes' WHERE id = ${root.sessionId}`;
    });
    const stale = await setMode(world, root, target.account.id, exportOnly(3));
    expect(stale.status).toBe(401);
    expect(await problemOf(stale)).toMatchObject({ code: "reauth_required" });
    expect(await accountRow(target.account.id)).toMatchObject({ access_mode: "full" });
  }, TEST_TIMEOUT_MS);

  it("lists the period with the accounts and reports the mode of one that is disabled as disabled", async () => {
    const world = serve();
    const root = await admin(world);
    const { person } = await member(world);
    expect((await setMode(world, root, person.account.id, exportOnly(5, "disable"))).status).toBe(200);

    const listed = (await (await send(world, "GET", ACCOUNTS, { cookie: root.cookie })).json()) as { items: { id: string; accessMode: string; exportOnlyEndAction: string | null }[] };

    expect(listed.items.find((item) => item.id === person.account.id)).toMatchObject({ accessMode: "exportOnly", exportOnlyEndAction: "disable" });
    expect(listed.items.find((item) => item.id === root.account.id)).toMatchObject({ accessMode: "full", exportOnlyEndAction: null });
  }, TEST_TIMEOUT_MS);
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

async function startWorker(failFor?: string): Promise<{ worker: RunningWorker; created: Worker }> {
  // A worker that is still running takes the job of the next one, with its own database, so one runs at a time.
  await worker?.shutdown();
  worker = undefined;
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const created = createWorker({
    config,
    adapters: { ...adapters(), mail },
    modules: [],
    logger: recordingLogger(),
    database:
      failFor === undefined
        ? tenantDatabase(database())
        : { ...tenantDatabase(database()), withTenant: (context, work) => (context.accountId === failFor ? Promise.reject(new Error("the transaction of this account fails")) : database().tenant.withTenant(context, work)) },
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  });
  const running = await created.start();
  worker = running;
  return { worker: running, created };
}

async function enqueueJob(failFor?: string): Promise<string> {
  const { worker: running, created } = await startWorker(failFor);
  const job = created.jobs.find((candidate) => candidate.name === JOB);
  if (job === undefined) {
    throw new Error("the worker does not register the job");
  }
  const id = await running.enqueue(job, {});
  if (id === null) {
    throw new Error("the job was not enqueued");
  }
  return id;
}

async function runJob(): Promise<void> {
  const id = await enqueueJob();
  await until(async () => {
    const rows = await database().owner<{ state: string }[]>`SELECT state FROM pgboss.job WHERE id = ${id}`;
    return rows[0]?.state === "completed" || rows[0]?.state === "failed";
  }, `the job ${id}`);
}

describe("the job that ends the period", () => {
  it("is registered with a daily schedule by the worker of the CE image", async () => {
    const { created } = await startWorker();
    expect(created.jobs.map((job) => job.name)).toContain(JOB);
    expect(created.schedules.filter((schedule) => schedule.job === JOB)).toEqual([{ name: JOB, cron: "20 3 * * *", job: JOB }]);
  });

  it(
    "deletes the account with its workspace and its sessions once the end date has passed, and the sign-in fails with the generic error; a second run does nothing",
    async () => {
      const world = serve();
      const root = await admin(world);
      const { person, token } = await member(world);
      expect((await setMode(world, root, person.account.id, exportOnly(2, "delete"))).status).toBe(200);
      await runJob();
      expect(await accountRow(person.account.id)).toMatchObject({ access_mode: "export_only" });
      expect((await send(world, "GET", ME, { cookie: person.cookie })).status).toBe(200);

      await lapse(person.account.id);
      await runJob();

      await until(async () => (await accountRow(person.account.id)) === undefined, "the account to be deleted");
      expect(await loginStatus(world, person)).toBe(401);
      expect((await send(world, "GET", ME, { cookie: person.cookie })).status).toBe(401);
      expect((await send(world, "GET", BOOKMARKS, bearer(token))).status).toBe(401);
      const ended = (await instanceEvents()).filter((event) => event.action === "instance.account_export_only_ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]).toEqual({ actor_account_id: null, actor_type: "system", action: "instance.account_export_only_ended", entity_id: null, metadata: { endAction: "delete" } });
      await runJob();
      expect((await instanceEvents()).filter((event) => event.action === "instance.account_export_only_ended")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "disables the account when that is the end action: the sessions end, the generic sign-in error follows, and the data stays",
    async () => {
      const world = serve();
      const root = await admin(world);
      const { person, token } = await member(world);
      expect((await setMode(world, root, person.account.id, exportOnly(2, "disable"))).status).toBe(200);
      await lapse(person.account.id);

      await runJob();

      const row = await accountRow(person.account.id);
      expect(row).toMatchObject({ access_mode: "full", export_only_until: null });
      expect(row?.disabled_at).not.toBeNull();
      expect(await loginStatus(world, person)).toBe(401);
      expect((await send(world, "GET", ME, { cookie: person.cookie })).status).toBe(401);
      expect((await send(world, "GET", BOOKMARKS, bearer(token))).status).toBe(401);
      expect(Number(((await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM bookmarks`;
      }))[0]?.count)))
        .toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "disables instead of deleting an account that is the only owner of a workspace with other members, so its access ends and the workspace keeps its content",
    async () => {
      const world = serve();
      const root = await admin(world);
      const { person } = await member(world);
      const colleague = await harness.person(world);
      const { workspaceId } = await harness.workspaceOf([
        { person, role: "owner" },
        { person: colleague, role: "member" },
      ]);
      expect((await setMode(world, root, person.account.id, exportOnly(2, "delete"))).status).toBe(200);
      await lapse(person.account.id);

      await runJob();

      const row = await accountRow(person.account.id);
      expect(row?.disabled_at).not.toBeNull();
      expect(row).toMatchObject({ access_mode: "full" });
      expect((await harness.rolesOf(workspaceId))[person.account.id]).toBe("owner");
      expect(await loginStatus(world, person)).toBe(401);
      const ended = (await instanceEvents()).filter((event) => event.action === "instance.account_export_only_ended" && event.entity_id === person.account.id);
      expect(ended).toEqual([expect.objectContaining({ metadata: { endAction: "disable" } })]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends the other accounts when one fails, and fails the run so that the next one tries the account again",
    async () => {
      const world = serve();
      const root = await admin(world);
      const failing = await member(world);
      const other = await member(world);
      for (const { person } of [failing, other]) {
        expect((await setMode(world, root, person.account.id, exportOnly(2, "disable"))).status).toBe(200);
        await lapse(person.account.id);
      }

      const endedBefore = (await instanceEvents()).filter((event) => event.action === "instance.account_export_only_ended").length;
      const id = await enqueueJob(failing.person.account.id);

      await until(async () => (await accountRow(other.person.account.id))?.disabled_at != null, "the other account to be ended");
      await until(async () => {
        const rows = await database().owner<{ state: string; output: unknown }[]>`SELECT state, output FROM pgboss.job WHERE id = ${id}`;
        if (rows[0]?.state === "completed") {
          throw new Error(`the run completed: ${JSON.stringify(rows[0].output)}`);
        }
        return rows[0]?.state === "retry" || rows[0]?.state === "failed";
      }, "the run to fail");
      expect(await accountRow(failing.person.account.id)).toMatchObject({ access_mode: "export_only", disabled_at: null });
      expect((await instanceEvents()).filter((event) => event.action === "instance.account_export_only_ended")).toHaveLength(endedBefore + 1);
      // The retry of the run would end it: it is not left due for the tests that follow.
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE accounts SET access_mode = 'full', export_only_until = NULL, export_only_end_action = NULL WHERE id = ${failing.person.account.id}`;
      });
    },
    TEST_TIMEOUT_MS,
  );

  it("leaves an account whose period has not ended alone", async () => {
    const world = serve();
    const root = await admin(world);
    const { person } = await member(world);
    expect((await setMode(world, root, person.account.id, exportOnly(2, "delete"))).status).toBe(200);
    const before = (await instanceEvents()).length;

    await runJob();

    expect(await accountRow(person.account.id)).toMatchObject({ access_mode: "export_only", disabled_at: null });
    expect((await instanceEvents()).length).toBe(before);
  }, TEST_TIMEOUT_MS);
});
