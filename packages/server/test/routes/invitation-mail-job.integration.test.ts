import { setTimeout as sleep } from "node:timers/promises";
import { hashCredentialToken, type MailMessage, type MailPort } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { invitationSendJob } from "../../src/worker/jobs/invitation-mail.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The invitation.send job against the requests that renew an invitation after it was queued (doc 02 section
// 3.4, doc 05 section 2.2, doc 10 T4 and T19). The failure scenario: an admin creates or resends an invitation
// (a mail job is queued and has not run), copies a link with POST /invitations/{id}/link, and the job then runs
// and replaces the stored hash, so the copied link stops matching. Also: a job whose invitation nothing renewed
// still mails a link that matches, and so does the retry of such a job after a failed send; the plaintext token is
// in no queued payload, audit event or log.

const INVITATIONS = "/api/v1/invitations";
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";
let worker: RunningWorker | undefined;
let failures = 0;

/** A mail port that refuses its next `failures` sends. */
const mail: MailPort = {
  available: true,
  send: (message: MailMessage) => {
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new Error("the mail port refused the message"));
    }
    return inbox.send(message);
  },
};

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
  failures = 0;
});

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
  inbox.clear();
});

afterAll(() => harness.stop());

interface InvitationRow {
  readonly id: string;
  readonly token_hash: Buffer;
  readonly mail_ticket: string | null;
}

function rowsOf(workspaceId: string): Promise<InvitationRow[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return [...(await tx<InvitationRow[]>`SELECT id, token_hash, mail_ticket FROM workspace_invitations WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`)];
  });
}

interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
}

function jobsOf(workspaceId: string): Promise<JobRow[]> {
  return database().app<JobRow[]>`SELECT id, state, data FROM pgboss.job WHERE name = 'invitation.send' AND data->>'workspaceId' = ${workspaceId} ORDER BY created_on, id`.then((rows) => [...rows]);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

function jobContext(logger = recordingLogger()): ModuleContext {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const tenants = tenantDatabase(database());
  return { config, logger, adapters: { ...adapters(), mail }, withTenant: tenants.withTenant.bind(tenants) };
}

/** Runs the queued job as the worker would hand it over, once. */
function runJob(job: JobRow, logger = recordingLogger()): Promise<void> {
  return invitationSendJob.handle(job.data, jobContext(logger));
}

async function startWorker(logger = recordingLogger()): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: { ...adapters(), mail },
    modules: [],
    logger,
    database: tenantDatabase(database()),
    pollingIntervalSeconds: 0.5,
    shutdownTimeoutMs: 500,
  }).start();
}

async function workspace(world: World) {
  const owner = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
  return { workspaceId, owner };
}

async function invite(world: World, person: Person, email: string): Promise<string> {
  const response = await send(world, "POST", INVITATIONS, { cookie: person.cookie }, { email, role: "member" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function resend(world: World, person: Person, id: string): Promise<void> {
  expect((await send(world, "POST", `${INVITATIONS}/${id}/resend`, { cookie: person.cookie })).status).toBe(200);
}

async function linkOf(world: World, person: Person, id: string): Promise<string> {
  const response = await send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: person.cookie });
  expect(response.status).toBe(200);
  const { link } = (await response.json()) as { link: string };
  const prefix = `${world.origin}/invite/`;
  expect(link.startsWith(prefix)).toBe(true);
  return link.slice(prefix.length);
}

function matches(row: InvitationRow | undefined, token: string): boolean {
  return row?.token_hash.equals(hashCredentialToken(token) ?? Buffer.alloc(0)) === true;
}

describe("the invitation.send job and a link issued after it was queued", { timeout: TEST_TIMEOUT_MS }, () => {
  it("leaves the link of POST /invitations/{id}/link working when the worker runs the job queued by the create, and mails nothing that ends it", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, owner } = await workspace(world);
    const id = await invite(world, owner, "grace@example.test");
    const token = await linkOf(world, owner, id);
    expect(matches((await rowsOf(workspaceId))[0], token)).toBe(true);

    await startWorker();
    await until(async () => (await jobsOf(workspaceId)).every((job) => job.state === "completed"), "the job to complete");

    expect(matches((await rowsOf(workspaceId))[0], token)).toBe(true);
    expect(inbox.sent).toEqual([]);
  });

  it("leaves the link working when the job queued by a resend runs after it", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, owner } = await workspace(world);
    const id = await invite(world, owner, "grace@example.test");
    await resend(world, owner, id);
    const token = await linkOf(world, owner, id);
    const jobs = await jobsOf(workspaceId);
    expect(jobs).toHaveLength(2);

    for (const job of jobs) {
      await runJob(job);
    }

    expect(matches((await rowsOf(workspaceId))[0], token)).toBe(true);
    expect(inbox.sent).toEqual([]);
  });

  it("mails a stale job's successor only: a resend after the create makes the first job send nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, owner } = await workspace(world);
    const id = await invite(world, owner, "grace@example.test");
    await resend(world, owner, id);
    const [first, second] = await jobsOf(workspaceId);
    if (first === undefined || second === undefined) {
      throw new Error("expected two queued jobs");
    }
    const before = (await rowsOf(workspaceId))[0]?.token_hash;

    await runJob(first);

    expect(inbox.sent).toEqual([]);
    expect((await rowsOf(workspaceId))[0]?.token_hash.equals(before ?? Buffer.alloc(0))).toBe(true);

    await runJob(second);

    expect(inbox.sent).toHaveLength(1);
    expect(matches((await rowsOf(workspaceId))[0], String(inbox.sent[0]?.data["token"]))).toBe(true);
  });

  it("mails a link that matches the stored hash when nothing renewed the invitation since the job was queued", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, owner } = await workspace(world);
    await invite(world, owner, "grace@example.test");
    const logger = recordingLogger();
    await startWorker(logger);

    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    const token = String(inbox.sent[0]?.data["token"]);
    expect(inbox.sent[0]).toMatchObject({ template: "invitation", to: "grace@example.test" });
    expect(matches((await rowsOf(workspaceId))[0], token)).toBe(true);
    expect((await jobsOf(workspaceId))[0]?.data["mailTicket"]).toBe((await rowsOf(workspaceId))[0]?.mail_ticket);
    const stores = JSON.stringify([await database().owner`SELECT data FROM pgboss.job`, logger.entries, logger.requests]);
    expect(stores).not.toContain(token);
  });

  it("ends with a working link mailed when the job is retried after a send that failed", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, owner } = await workspace(world);
    await invite(world, owner, "grace@example.test");
    const [job] = await jobsOf(workspaceId);
    if (job === undefined) {
      throw new Error("expected a queued job");
    }
    failures = 1;

    await expect(runJob(job)).rejects.toThrow("the mail port refused the message");
    expect(inbox.sent).toEqual([]);
    await runJob(job);

    expect(inbox.sent).toHaveLength(1);
    expect(matches((await rowsOf(workspaceId))[0], String(inbox.sent[0]?.data["token"]))).toBe(true);
  });

  it("sends nothing from a retry once a link was issued after the failed attempt", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, owner } = await workspace(world);
    const id = await invite(world, owner, "grace@example.test");
    const [job] = await jobsOf(workspaceId);
    if (job === undefined) {
      throw new Error("expected a queued job");
    }
    failures = 1;
    await expect(runJob(job)).rejects.toThrow("the mail port refused the message");
    const token = await linkOf(world, owner, id);

    await runJob(job);

    expect(inbox.sent).toEqual([]);
    expect(matches((await rowsOf(workspaceId))[0], token)).toBe(true);
  });
});
