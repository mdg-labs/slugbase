import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mailSendJob } from "../../src/worker/jobs/mail-send.ts";
import { loadConfig } from "../../src/config/index.ts";
import { seedAccount, sessionRows } from "../auth/support.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, bearer, send, workspaceHarness, type World } from "../workspaces/support.ts";

// The instance settings and the test email through the whole chain over the migrated database (doc 04 section
// 10.10, doc 02 sections 3.2 and 11.3, doc 10 T3 and T14). The failure scenarios: a caller the instanceAdmin policy
// excludes that reads or changes the settings or queues a test email, a notice that reaches the sign-in page as
// anything but text, workspace creation that stays open after an admin turned it off, a setting that needs a
// restart, and a test email queued without a mail adapter or without its audit event.

const SETTINGS = "/api/v1/instance/settings";
const TEST_MAIL = "/api/v1/instance/mail/test";
const WORKSPACES = "/api/v1/workspaces";
const LOGIN = "/api/v1/auth/login";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

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

async function caller(world: World, options: { flag: boolean; mfa: boolean; verified?: boolean }): Promise<Caller> {
  const account = await seedAccount(database(), { emailVerified: options.verified !== false, instanceAdmin: options.flag });
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

interface EventRow {
  actor_account_id: string | null;
  action: string;
  metadata: Record<string, unknown>;
}

async function instanceEvents(): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`SELECT actor_account_id, action, metadata FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`;
  });
  return [...rows];
}

async function mailJobs(): Promise<{ data: Record<string, unknown> }[]> {
  return [...(await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send' ORDER BY created_on`)];
}

async function storedSettings(): Promise<Record<string, unknown>[]> {
  return [...(await database().owner<Record<string, unknown>[]>`SELECT allow_workspace_creation, display_name, sign_in_notice FROM instance_settings`)];
}

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
  await database().owner`DELETE FROM instance_settings`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM audit_events WHERE workspace_id IS NULL`;
  });
});

describe("GET and PATCH /instance/settings", () => {
  it("answers an instance admin with every setting null while none was saved", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });

    const response = await send(world, "GET", SETTINGS, { cookie: admin.cookie });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowWorkspaceCreation: null, displayName: null, signInNotice: null });
  });

  it("writes one instance audit event for each read, naming the admin and no setting", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });
    await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { displayName: "Acme Links" });

    await send(world, "GET", SETTINGS, { cookie: admin.cookie });
    await send(world, "GET", SETTINGS, { cookie: admin.cookie });

    const events = (await instanceEvents()).filter((event) => event.action === "instance.settings_viewed");
    expect(events).toEqual([
      { actor_account_id: admin.accountId, action: "instance.settings_viewed", metadata: {} },
      { actor_account_id: admin.accountId, action: "instance.settings_viewed", metadata: {} },
    ]);
    expect(JSON.stringify(events)).not.toContain("Acme");
  });

  it("stores what the admin sends, keeps what it leaves out, clears with null, and writes one instance audit event per change that names the settings and no value", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });

    const first = await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { displayName: "  Acme Links  ", signInNotice: "Maintenance on Friday." });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ allowWorkspaceCreation: null, displayName: "Acme Links", signInNotice: "Maintenance on Friday." });

    const second = await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { allowWorkspaceCreation: true, signInNotice: null });
    expect(await second.json()).toEqual({ allowWorkspaceCreation: true, displayName: "Acme Links", signInNotice: null });

    const read = await send(world, "GET", SETTINGS, { cookie: admin.cookie });
    expect(await read.json()).toEqual({ allowWorkspaceCreation: true, displayName: "Acme Links", signInNotice: null });
    const events = await instanceEvents();
    expect(events).toEqual([
      { actor_account_id: admin.accountId, action: "instance.settings_changed", metadata: { settings: "displayName,signInNotice" } },
      { actor_account_id: admin.accountId, action: "instance.settings_changed", metadata: { settings: "allowWorkspaceCreation,signInNotice" } },
      { actor_account_id: admin.accountId, action: "instance.settings_viewed", metadata: {} },
    ]);
    expect(JSON.stringify(events)).not.toContain("Acme");
  });

  it.each([
    ["no setting", {}],
    ["a name that is blank", { displayName: "   " }],
    ["a name of 101 characters", { displayName: "n".repeat(101) }],
    ["a notice of 501 characters", { signInNotice: "n".repeat(501) }],
    ["a notice that is blank", { signInNotice: " \n " }],
    ["a NUL character in the name", { displayName: "a\u0000b" }],
    ["a NUL character in the notice", { signInNotice: "a\u0000b" }],
    ["a flag that is not a boolean", { allowWorkspaceCreation: "yes" }],
    ["a field the operation does not declare", { displayName: "Acme", theme: "dark" }],
  ])("answers 422 for %s and changes nothing", async (_name, body) => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });
    await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { displayName: "Kept" });
    const events = await instanceEvents();

    const response = await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, body);

    expect(response.status).toBe(422);
    expect(await storedSettings()).toEqual([{ allow_workspace_creation: null, display_name: "Kept", sign_in_notice: null }]);
    expect(await instanceEvents()).toEqual(events);
  });

  it("accepts a notice of exactly 500 characters", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });
    const response = await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { signInNotice: "n".repeat(500) });
    expect(response.status).toBe(200);
  });

  describe("refuses everyone the instanceAdmin policy excludes, changing nothing and reading nothing out", () => {
    const attempts = [
      ["GET", undefined],
      ["PATCH", { displayName: "Hijacked", allowWorkspaceCreation: true }],
    ] as const;

    it.each(attempts)("answers 401 unauthenticated to %s without a credential", async (method, body) => {
      const world = harness.serve();
      const response = await send(world, method, SETTINGS, {}, body);
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("unauthenticated");
      expect(await storedSettings()).toEqual([]);
    });

    it.each(attempts)("answers 403 forbidden to %s from an account that holds no flag, even with a second factor", async (method, body) => {
      const world = harness.serve();
      const admin = await caller(world, { flag: true, mfa: true });
      await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { displayName: "Kept" });
      const member = await caller(world, { flag: false, mfa: true });

      const response = await send(world, method, SETTINGS, { cookie: member.cookie }, body);

      expect(response.status).toBe(403);
      const text = await response.text();
      expect((JSON.parse(text) as { code: string }).code).toBe("forbidden");
      expect(text).not.toContain("Kept");
      expect(await storedSettings()).toEqual([{ allow_workspace_creation: null, display_name: "Kept", sign_in_notice: null }]);
      expect((await instanceEvents()).filter((event) => event.action === "instance.settings_viewed")).toEqual([]);
    });

    it.each(attempts)("answers 403 forbidden to %s from an instance admin who has no second factor enrolled", async (method, body) => {
      const world = harness.serve();
      const admin = await caller(world, { flag: true, mfa: false });
      const response = await send(world, method, SETTINGS, { cookie: admin.cookie }, body);
      expect(response.status).toBe(403);
      expect(await storedSettings()).toEqual([]);
    });

    it.each(attempts)("answers 403 forbidden to %s with an API token, even of an admin with a second factor", async (method, body) => {
      const world = harness.serve();
      const admin = await harness.person(world);
      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${admin.account.id}, true)`;
        await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${admin.account.id}`;
      });
      await enrolSecondFactor(admin.account.id);
      const { workspaceId } = await harness.workspaceOf([{ person: admin, role: "owner" }]);
      const value = await harness.token(workspaceId, admin, "read-write");

      const response = await send(world, method, SETTINGS, bearer(value), body);

      expect(response.status).toBe(403);
      expect(await storedSettings()).toEqual([]);
    });

    it("answers 401 mfa_required to a session still waiting for its second factor, even of an admin", async () => {
      const world = harness.serve();
      const account = await seedAccount(database(), { emailVerified: true, instanceAdmin: true });
      await enrolSecondFactor(account.id);
      const login = await send(world, "POST", LOGIN, {}, { email: account.email, password: account.password, remember: false });
      const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(login.headers.get("set-cookie") ?? "")?.[1];
      expect((await sessionRows(database(), account.id)).map((session) => session.level)).toEqual(["partial"]);

      const response = await send(world, "PATCH", SETTINGS, { cookie: `${SESSION_COOKIE}=${String(token)}` }, { displayName: "Hijacked" });

      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("mfa_required");
      expect(await storedSettings()).toEqual([]);
    });

    it("answers 403 to a PATCH from another origin", async () => {
      const world = harness.serve();
      const admin = await caller(world, { flag: true, mfa: true });
      const response = await send(world, "PATCH", SETTINGS, { cookie: admin.cookie, origin: "https://evil.example" }, { displayName: "Hijacked" });
      expect(response.status).toBe(403);
      expect(await storedSettings()).toEqual([]);
    });
  });
});

describe("the workspace creation setting", () => {
  const create = (world: World, as: { cookie: string }) => send(world, "POST", WORKSPACES, { cookie: as.cookie }, { name: "Mine" });
  const canCreate = async (world: World, as: { cookie: string }): Promise<boolean> =>
    ((await (await send(world, "GET", WORKSPACES, { cookie: as.cookie })).json()) as { canCreate: boolean }).canCreate;

  it("turning creation off stops POST /workspaces for an ordinary account on the very next request, on a deployment that allows it by default", async () => {
    const world = harness.serve({ allowWorkspaceCreation: true });
    const admin = await caller(world, { flag: true, mfa: true });
    const ordinary = await caller(world, { flag: false, mfa: false });
    expect((await create(world, ordinary)).status).toBe(201);
    expect(await canCreate(world, ordinary)).toBe(true);

    expect((await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { allowWorkspaceCreation: false })).status).toBe(200);

    const refused = await create(world, ordinary);
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe("forbidden");
    expect(await canCreate(world, ordinary)).toBe(false);
  });

  it("turning creation on opens POST /workspaces on a deployment that refuses it by default, and clearing the setting restores the default", async () => {
    const world = harness.serve({ allowWorkspaceCreation: false });
    const admin = await caller(world, { flag: true, mfa: true });
    const ordinary = await caller(world, { flag: false, mfa: false });
    expect((await create(world, ordinary)).status).toBe(403);

    await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { allowWorkspaceCreation: true });
    expect((await create(world, ordinary)).status).toBe(201);
    expect(await canCreate(world, ordinary)).toBe(true);

    await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { allowWorkspaceCreation: null });
    expect((await create(world, ordinary)).status).toBe(403);
    expect(await canCreate(world, ordinary)).toBe(false);
  });

  it("is not changed by an ordinary account, whose attempt leaves creation as it was", async () => {
    const world = harness.serve({ allowWorkspaceCreation: false });
    const ordinary = await caller(world, { flag: false, mfa: true });

    expect((await send(world, "PATCH", SETTINGS, { cookie: ordinary.cookie }, { allowWorkspaceCreation: true })).status).toBe(403);

    expect((await create(world, ordinary)).status).toBe(403);
  });
});

describe("GET /api/config", () => {
  it("carries the display name and the notice an admin stored, the notice as the plain text it was sent", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });
    const notice = '<script>alert("x")</script> & <b>maintenance</b>';
    await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { displayName: "Acme Links", signInNotice: notice });

    const response = await send(world, "GET", "/api/config", {});

    expect(response.status).toBe(200);
    expect(((await response.json()) as { instance: unknown }).instance).toEqual({ displayName: "Acme Links", signInNotice: notice });
  });

  it("reports the product name and no notice before an admin stored anything", async () => {
    const world = harness.serve();
    const response = await send(world, "GET", "/api/config", {});
    expect(((await response.json()) as { instance: unknown }).instance).toEqual({ displayName: "SlugBase", signInNotice: null });
  });
});

describe("POST /instance/mail/test", () => {
  it("queues a test message to the caller and answers 202, writing the instance audit event in the same transaction", async () => {
    const mail = new InMemoryMail();
    const world = harness.serve({ mail });
    const admin = await caller(world, { flag: true, mfa: true });

    const response = await send(world, "POST", TEST_MAIL, { cookie: admin.cookie });

    expect(response.status).toBe(202);
    expect(await mailJobs()).toEqual([{ data: { template: "testMail", accountId: admin.accountId } }]);
    expect(await instanceEvents()).toEqual([{ actor_account_id: admin.accountId, action: "instance.test_mail_queued", metadata: {} }]);
    expect(mail.sent).toEqual([]);
  });

  it("is sent by the mail.send job to the address of the account that asked, in its language, and to nobody else", async () => {
    const mail = new InMemoryMail();
    const world = harness.serve({ mail });
    const admin = await caller(world, { flag: true, mfa: true });
    await caller(world, { flag: false, mfa: true });
    await send(world, "POST", TEST_MAIL, { cookie: admin.cookie });
    const [job] = await mailJobs();
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;

    await mailSendJob.handle(job?.data, { config, logger: recordingLogger(), adapters: { ...adapters(), mail }, withTenant: (context, fn) => database().tenant.withTenant(context, fn) });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ template: "testMail", to: admin.email, locale: "en" });
  });

  it("answers 503 mail_unavailable when no mail adapter is configured, and queues and records nothing", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });

    const response = await send(world, "POST", TEST_MAIL, { cookie: admin.cookie });

    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("mail_unavailable");
    expect(await mailJobs()).toEqual([]);
    expect(await instanceEvents()).toEqual([]);
  });

  describe("refuses everyone the instanceAdmin policy excludes, queuing nothing", () => {
    it("answers 401 without a credential", async () => {
      const world = harness.serve({ mail: new InMemoryMail() });
      expect((await send(world, "POST", TEST_MAIL, {})).status).toBe(401);
      expect(await mailJobs()).toEqual([]);
    });

    it("answers 403 to an account that holds no flag, even with a second factor", async () => {
      const world = harness.serve({ mail: new InMemoryMail() });
      const member = await caller(world, { flag: false, mfa: true });
      const response = await send(world, "POST", TEST_MAIL, { cookie: member.cookie });
      expect(response.status).toBe(403);
      expect(await mailJobs()).toEqual([]);
      expect(await instanceEvents()).toEqual([]);
    });

    it("answers 403 to an instance admin who has no second factor enrolled", async () => {
      const world = harness.serve({ mail: new InMemoryMail() });
      const admin = await caller(world, { flag: true, mfa: false });
      expect((await send(world, "POST", TEST_MAIL, { cookie: admin.cookie })).status).toBe(403);
      expect(await mailJobs()).toEqual([]);
    });

    it("answers 403 to a request from another origin", async () => {
      const world = harness.serve({ mail: new InMemoryMail() });
      const admin = await caller(world, { flag: true, mfa: true });
      expect((await send(world, "POST", TEST_MAIL, { cookie: admin.cookie, origin: "https://evil.example" })).status).toBe(403);
      expect(await mailJobs()).toEqual([]);
    });
  });
});
