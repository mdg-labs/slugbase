import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness } from "../workspaces/support.ts";

// The "account disabled" email through the whole path (doc 02 sections 11.2 and 12, doc 01 section 8.1):
// PATCH /api/v1/instance/accounts/{id} queues `mail.send` in the transaction that disables the account, and the worker
// sends it to the account, which the disabling has already made a disabled account, in its own language. The failure
// scenarios: a message that never reaches a disabled account because the job treats it like a gone one, a message in the
// wrong language or to the wrong address, and an address or a name in the queued payload.

const ACCOUNTS = "/api/v1/instance/accounts";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
let worker: RunningWorker | undefined;

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
  inbox.clear();
});

afterAll(() => harness.stop());

async function startWorker(): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: { ...adapters(), mail },
    modules: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
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

describe("the account disabled email", { timeout: TEST_TIMEOUT_MS }, () => {
  it.each(["en", "de"] as const)("is sent to the disabled account in its language (%s), from a payload that holds identifiers only", async (locale) => {
    const world = harness.serve({ mail });
    const root = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${root.account.id}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = true, mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${root.account.id}`;
    });
    const target = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${target.account.id}, true)`;
      await tx`UPDATE accounts SET display_name = 'Grace Hopper', locale = ${locale} WHERE id = ${target.account.id}`;
    });

    const response = await send(world, "PATCH", `${ACCOUNTS}/${target.account.id}`, { cookie: root.cookie }, { disabled: true });
    expect(response.status).toBe(200);
    const queued = await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send' AND data->>'accountId' = ${target.account.id}`;
    expect(queued.map((job) => job.data)).toEqual([{ template: "accountDisabled", accountId: target.account.id }]);
    await startWorker();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    expect(inbox.sent).toEqual([{ template: "accountDisabled", to: target.account.email, locale, data: { displayName: "Grace Hopper" } }]);
  });
});
