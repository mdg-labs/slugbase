import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { seedAccount } from "../auth/support.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, bearer, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The recovery operations of the instance admin through the whole chain over the migrated database (doc 04 section
// 10.10, doc 02 sections 2.5, 2.6, 2.7 and 11.2, doc 10 T7, T17 and T18): POST /instance/accounts/{id}/mfa-reset,
// /password-reset-link and /verification-email, and PATCH /instance/accounts/{id} with emailVerified. The failure
// scenarios: after a reset of the second factor the account signs in with its password alone only because the factor is
// off, and nothing the admin receives holds a secret or a code; a reset link that is returned although it was mailed, or
// that is mailed although no mail is configured; a link the redemption refuses, or one that leaves the target's sessions
// alive once it is redeemed; a recovery that skips the re-authentication it declares, runs for a caller the instanceAdmin
// policy excludes, or reaches a disabled account; and a request that is refused or changes nothing but writes an event,
// deletes a session or sends a mail.

const ACCOUNTS = "/api/v1/instance/accounts";
const LOGIN = "/api/v1/auth/login";
const RESET_PASSWORD = "/api/v1/auth/password/reset";
const ME = "/api/v1/me";
const MAIL_JOB = "mail.send";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
const SECRET = "sealed-totp-secret";
const NEW_PASSWORD = "a brand new long password";

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

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
});

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

const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

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

interface Admin {
  readonly accountId: string;
  readonly cookie: string;
}

/** An instance admin with a second factor whose session re-authenticated just now. */
async function admin(world: World): Promise<Admin & { readonly person: Person }> {
  const person = await harness.person(world);
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
  });
  await enrolSecondFactor(person.account.id);
  return { accountId: person.account.id, cookie: person.cookie, person };
}

async function setLocale(accountId: string, locale: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET display_name = 'Grace Hopper', locale = ${locale} WHERE id = ${accountId}`;
  });
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

async function linkIdentity(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (gen_random_uuid(), ${accountId}, 'idp', ${`subject-${accountId}`}, 'linked@example.test')`;
  });
}

async function resetTokens(accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM credential_tokens WHERE account_id = ${accountId} AND purpose = 'password_reset' AND used_at IS NULL`;
  });
  return rows[0]?.count ?? 0;
}

async function accountState(accountId: string): Promise<{ mfa: boolean; secret: boolean; codes: number; verified: boolean }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ mfa: boolean; secret: boolean; codes: number; verified: boolean }[]>`
      SELECT mfa_enabled_at IS NOT NULL AS mfa, mfa_secret IS NOT NULL AS secret, email_verified_at IS NOT NULL AS verified,
             (SELECT count(*)::int FROM mfa_backup_codes WHERE account_id = a.id) AS codes
      FROM accounts a WHERE id = ${accountId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is gone");
  }
  return row;
}

const statusOf = async (world: World, cookie: string): Promise<number> => (await send(world, "GET", ME, { cookie })).status;

const post = (world: World, as: { cookie: string }, id: string, action: "mfa-reset" | "password-reset-link" | "verification-email"): Promise<Response> =>
  send(world, "POST", `${ACCOUNTS}/${id}/${action}`, { cookie: as.cookie });

const patch = (world: World, as: { cookie: string }, id: string, body: unknown): Promise<Response> => send(world, "PATCH", `${ACCOUNTS}/${id}`, { cookie: as.cookie }, body);

async function login(world: World, person: Person, password = person.account.password): Promise<{ status: number; next?: string; cookie?: string }> {
  const response = await send(world, "POST", LOGIN, {}, { email: person.account.email, password, remember: false });
  const token = new RegExp(`${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  const body = response.status === 200 ? ((await response.json()) as { next: string }) : undefined;
  return { status: response.status, ...(body === undefined ? {} : { next: body.next }), ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }) };
}

describe("POST /instance/accounts/{id}/mfa-reset", () => {
  it("turns the second factor off: the account signs in with its password alone only because the factor is off, its sessions end, and the admin receives no secret or code", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);
    expect(await login(world, target)).toMatchObject({ status: 200, next: "mfa" });
    expect(await accountState(target.account.id)).toEqual({ mfa: true, secret: true, codes: 1, verified: true });

    const response = await post(world, root, target.account.id, "mfa-reset");

    expect(response.status).toBe(204);
    const queued = await mailJobs();
    const text = await response.text();
    expect(text).toBe("");
    for (const [name, value] of response.headers) {
      expect(`${name}: ${value}`).not.toContain(SECRET);
    }
    expect(await accountState(target.account.id)).toEqual({ mfa: false, secret: false, codes: 0, verified: true });
    expect(await statusOf(world, target.cookie)).toBe(401);
    const afterwards = await login(world, target);
    expect(afterwards).toMatchObject({ status: 200, next: "done" });
    expect(await statusOf(world, afterwards.cookie ?? "")).toBe(200);
    const stored = JSON.stringify([await instanceEvents(), queued]);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect((await instanceEvents()).at(-1)).toEqual({ actor_account_id: root.accountId, action: "instance.account_mfa_reset", entity_type: "account", entity_id: target.account.id, metadata: {} });
    expect(queued).toEqual([{ template: "mfaReset", accountId: target.account.id }]);
  });

  it("queues no mail where none is configured, and still resets", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);

    expect((await post(world, root, target.account.id, "mfa-reset")).status).toBe(204);

    expect(await accountState(target.account.id)).toMatchObject({ mfa: false, secret: false, codes: 0 });
    expect(await mailJobs()).toEqual([]);
    expect((await instanceEvents()).at(-1)).toMatchObject({ action: "instance.account_mfa_reset" });
  });

  it("answers 204 and changes nothing for an account whose second factor is off already: no event, no deleted session, no mail", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await post(world, root, target.account.id, "mfa-reset");

    expect(response.status).toBe(204);
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it("refuses a disabled account and the admin's own account with 422 validation_failed and a field code on id, and a missing account with 404, changing nothing", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const disabled = await harness.person(world);
    await enrolSecondFactor(disabled.account.id);
    expect((await patch(world, root, disabled.account.id, { disabled: true })).status).toBe(200);
    await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
    const events = await instanceEvents();

    const ofDisabled = await post(world, root, disabled.account.id, "mfa-reset");
    const ofSelf = await post(world, root, root.accountId, "mfa-reset");
    const missing = await post(world, root, "0192f3a0-aaaa-7000-8000-00000000dead", "mfa-reset");

    expect(ofDisabled.status).toBe(422);
    expect(await ofDisabled.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "account_disabled" }] });
    expect(ofSelf.status).toBe(422);
    expect(await ofSelf.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "self" }] });
    expect(missing.status).toBe(404);
    expect(await accountState(disabled.account.id)).toMatchObject({ mfa: true, secret: true, codes: 1 });
    expect(await accountState(root.accountId)).toMatchObject({ mfa: true, secret: true });
    expect(await statusOf(world, root.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });
});

describe("POST /instance/accounts/{id}/password-reset-link", { timeout: TEST_TIMEOUT_MS }, () => {
  it("where mail is configured mails the link and returns none: no token exists until the mail job makes it, and the audit event names the delivery", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);

    const response = await post(world, root, target.account.id, "password-reset-link");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ delivery: "mail", link: null });
    expect(text).not.toContain("reset-password");
    expect(await resetTokens(target.account.id)).toBe(0);
    expect(await mailJobs()).toEqual([{ template: "passwordReset", accountId: target.account.id }]);
    expect((await instanceEvents()).at(-1)).toEqual({ actor_account_id: root.accountId, action: "instance.account_reset_link_issued", entity_type: "account", entity_id: target.account.id, metadata: { delivery: "mail" } });
    expect(await statusOf(world, target.cookie)).toBe(200);
  });

  it("where mail is configured the worker mails a link that redeems, and the response never carried it", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);
    await post(world, root, target.account.id, "password-reset-link");
    await startWorker();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    const message = inbox.sent[0];
    expect(message).toMatchObject({ template: "passwordReset", to: target.account.email });
    const token = message?.data["token"];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const redeemed = await send(world, "POST", RESET_PASSWORD, {}, { token, newPassword: NEW_PASSWORD });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ next: "done" });
    expect(await statusOf(world, target.cookie)).toBe(401);
  });

  it("where no mail is configured returns the link once, stores only its hash, and the link redeems: the sessions of the account end and it signs in with the new password", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);

    const response = await post(world, root, target.account.id, "password-reset-link");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { delivery: string; link: string };
    expect(body.delivery).toBe("link");
    expect(body.link).toMatch(new RegExp(`^${world.origin}/reset-password#token=[A-Za-z0-9_-]{43}$`));
    const token = body.link.slice(body.link.indexOf("#token=") + "#token=".length);
    expect(await mailJobs()).toEqual([]);
    expect(await resetTokens(target.account.id)).toBe(1);
    const stored = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ token_hash: Buffer }[]>`SELECT token_hash FROM credential_tokens WHERE account_id = ${target.account.id}`;
    });
    expect(stored.map((row) => row.token_hash.toString("base64url"))).not.toContain(token);
    expect(JSON.stringify(await instanceEvents())).not.toContain(token);
    expect((await instanceEvents()).at(-1)).toMatchObject({ action: "instance.account_reset_link_issued", metadata: { delivery: "link" } });

    const redeemed = await send(world, "POST", RESET_PASSWORD, {}, { token, newPassword: NEW_PASSWORD });
    expect(redeemed.status).toBe(200);
    expect(await statusOf(world, target.cookie)).toBe(401);
    expect(await login(world, target, NEW_PASSWORD)).toMatchObject({ status: 200, next: "done" });
    // The link works once.
    expect((await send(world, "POST", RESET_PASSWORD, {}, { token, newPassword: "yet another long password" })).status).not.toBe(200);
  });

  it("a second request replaces the first link, which then redeems no more", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const first = ((await (await post(world, root, target.account.id, "password-reset-link")).json()) as { link: string }).link;
    const second = ((await (await post(world, root, target.account.id, "password-reset-link")).json()) as { link: string }).link;
    const tokenOf = (link: string): string => link.slice(link.indexOf("#token=") + "#token=".length);

    expect((await send(world, "POST", RESET_PASSWORD, {}, { token: tokenOf(first), newPassword: NEW_PASSWORD })).status).not.toBe(200);
    expect((await send(world, "POST", RESET_PASSWORD, {}, { token: tokenOf(second), newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it.each([
    ["a disabled account", "account_disabled"],
    ["an account whose address was never verified", "email_unverified"],
    ["an account that signs in through a provider only", "no_password"],
  ] as const)("refuses %s with 422 %s on id, with or without mail, issuing, writing and queueing nothing", async (what, code) => {
    for (const withMail of [true, false]) {
      const world = harness.serve(withMail ? { mail } : {});
      const root = await admin(world);
      const target =
        code === "account_disabled"
          ? await harness.person(world)
          : await seedAccount(database(), { emailVerified: code !== "email_unverified", password: code === "no_password" ? null : undefined }).then((account) => ({ account }));
      if (code === "no_password") {
        await linkIdentity(target.account.id);
      }
      if (code === "account_disabled") {
        expect((await patch(world, root, target.account.id, { disabled: true })).status).toBe(200);
        await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
      }
      const events = await instanceEvents();

      const response = await post(world, root, target.account.id, "password-reset-link");

      expect(response.status, what).toBe(422);
      expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code }] });
      expect(await resetTokens(target.account.id)).toBe(0);
      expect(await instanceEvents()).toEqual(events);
      expect(await mailJobs()).toEqual([]);
    }
  });

  it("answers 404 for an account that does not exist", async () => {
    const world = harness.serve();
    const root = await admin(world);
    expect((await post(world, root, "0192f3a0-aaaa-7000-8000-00000000dead", "password-reset-link")).status).toBe(404);
  });
});

describe("POST /instance/accounts/{id}/verification-email", { timeout: TEST_TIMEOUT_MS }, () => {
  async function unverified(): Promise<{ account: { id: string; email: string } }> {
    return { account: await seedAccount(database(), { emailVerified: false }) };
  }

  it("queues the verification email for an unverified account in the transaction that writes the event, with the identifier only", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await unverified();

    const response = await post(world, root, target.account.id, "verification-email");

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(await mailJobs()).toEqual([{ template: "verifyEmail", accountId: target.account.id }]);
    expect((await instanceEvents()).at(-1)).toEqual({ actor_account_id: root.accountId, action: "instance.account_verification_resent", entity_type: "account", entity_id: target.account.id, metadata: {} });
  });

  it("the worker mails a verification link that verifies the account", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await unverified();
    await post(world, root, target.account.id, "verification-email");
    await startWorker();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    expect(inbox.sent[0]).toMatchObject({ template: "verifyEmail", to: target.account.email });
    const verified = await send(world, "POST", "/api/v1/auth/verify-email", {}, { token: inbox.sent[0]?.data["token"], password: NEW_PASSWORD });
    expect(verified.status).toBe(200);
    expect((await accountState(target.account.id)).verified).toBe(true);
  });

  it("answers 503 mail_unavailable where no mail is configured, writing and queueing nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await unverified();
    const events = await instanceEvents();

    const response = await post(world, root, target.account.id, "verification-email");

    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("mail_unavailable");
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it("refuses a verified address and a disabled account with 422 on id, and a missing account with 404, writing and queueing nothing", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const verified = await harness.person(world);
    const disabled = await unverified();
    expect((await patch(world, root, disabled.account.id, { disabled: true })).status).toBe(200);
    await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
    const events = await instanceEvents();

    const ofVerified = await post(world, root, verified.account.id, "verification-email");
    const ofDisabled = await post(world, root, disabled.account.id, "verification-email");

    expect(ofVerified.status).toBe(422);
    expect(await ofVerified.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "already_verified" }] });
    expect(ofDisabled.status).toBe(422);
    expect(await ofDisabled.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "account_disabled" }] });
    expect((await post(world, root, "0192f3a0-aaaa-7000-8000-00000000dead", "verification-email")).status).toBe(404);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });
});

describe("PATCH /instance/accounts/{id} with emailVerified", () => {
  it("marks the address verified, answers the account, writes one event for it, and the registrant's password no longer signs in", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await seedAccount(database(), { emailVerified: false });
    const registrant = { account: target } as Person;

    const response = await patch(world, root, target.id, { emailVerified: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: target.id, emailVerified: true, disabled: false });
    expect(await instanceEvents()).toEqual(expect.arrayContaining([{ actor_account_id: root.accountId, action: "instance.account_email_verified", entity_type: "account", entity_id: target.id, metadata: {} }]));
    expect((await login(world, registrant)).status).toBe(401);
  });

  it("takes the registrant's session and second factor, and the owner gets in through the reset link, handed over although mail is configured", async () => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const registrant = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET email_verified_at = NULL WHERE id = ${registrant.account.id}`;
    });
    await enrolSecondFactor(registrant.account.id);
    expect(await statusOf(world, registrant.cookie)).toBe(200);

    expect((await patch(world, root, registrant.account.id, { emailVerified: true })).status).toBe(200);

    expect(await statusOf(world, registrant.cookie)).toBe(401);
    expect(await accountState(registrant.account.id)).toEqual({ mfa: false, secret: false, codes: 0, verified: true });
    expect((await login(world, registrant)).status).toBe(401);
    await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;

    const issued = await post(world, root, registrant.account.id, "password-reset-link");

    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { delivery: string; link: string };
    expect(body.delivery).toBe("link");
    expect(await mailJobs()).toEqual([]);
    const token = body.link.slice(body.link.indexOf("#token=") + "#token=".length);
    expect((await send(world, "POST", RESET_PASSWORD, {}, { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await login(world, registrant, NEW_PASSWORD)).toMatchObject({ status: 200, next: "done" });
  });

  it("answers 200 and writes no event for an address that is verified already", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, root, target.account.id, { emailVerified: true });

    expect(response.status).toBe(200);
    expect(await instanceEvents()).toEqual(events);
  });

  it("answers 422 to false, and changes nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const target = await harness.person(world);
    const events = await instanceEvents();

    const response = await patch(world, root, target.account.id, { emailVerified: false });

    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe("validation_failed");
    expect((await accountState(target.account.id)).verified).toBe(true);
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("the recovery operations are for the instance admin, with re-authentication where they declare it", () => {
  const attempts = [
    ["POST", "mfa-reset", true],
    ["POST", "password-reset-link", true],
    ["POST", "verification-email", false],
  ] as const;

  it.each(attempts)("answers 401 to %s %s without a credential", async (_method, action) => {
    const world = harness.serve({ mail });
    const target = await harness.person(world);

    const response = await send(world, "POST", `${ACCOUNTS}/${target.account.id}/${action}`, {});

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("unauthenticated");
    expect(await statusOf(world, target.cookie)).toBe(200);
  });

  it.each(attempts)("answers 403 forbidden to %s %s from an account that holds no flag, even with a second factor and a fresh re-authentication", async (_method, action) => {
    const world = harness.serve({ mail });
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);
    const ordinary = await harness.person(world);
    await enrolSecondFactor(ordinary.account.id);
    const events = await instanceEvents();

    const response = await post(world, ordinary, target.account.id, action);

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("forbidden");
    expect(await accountState(target.account.id)).toMatchObject({ mfa: true, codes: 1 });
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it.each(attempts)("answers 403 forbidden to %s %s from an instance admin who has no second factor enrolled", async (_method, action) => {
    const world = harness.serve({ mail });
    const person = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
    });
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);

    const response = await post(world, person, target.account.id, action);

    expect(response.status).toBe(403);
    expect(await accountState(target.account.id)).toMatchObject({ mfa: true, codes: 1 });
  });

  it.each(attempts)("answers 403 forbidden to %s %s with an API token, even of an admin with a second factor", async (_method, action) => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const { workspaceId } = await harness.workspaceOf([{ person: root.person, role: "owner" }]);
    const value = await harness.token(workspaceId, root.person, "read-write");
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);

    const response = await send(world, "POST", `${ACCOUNTS}/${target.account.id}/${action}`, bearer(value));

    expect(response.status).toBe(403);
    expect(await accountState(target.account.id)).toMatchObject({ mfa: true, codes: 1 });
  });

  it.each(attempts)("answers 403 to %s %s from another origin", async (_method, action) => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);

    const response = await send(world, "POST", `${ACCOUNTS}/${target.account.id}/${action}`, { cookie: root.cookie, origin: "https://evil.example" });

    expect(response.status).toBe(403);
    expect(await accountState(target.account.id)).toMatchObject({ mfa: true, codes: 1 });
    expect(await mailJobs()).toEqual([]);
  });

  it.each(attempts.filter(([, , reauth]) => reauth))("answers 401 reauth_required to %s %s from a session that has not re-authenticated within ten minutes, changing nothing", async (_method, action) => {
    const world = harness.serve({ mail });
    const account = await seedAccount(database(), { emailVerified: true, instanceAdmin: true });
    const signedIn = await send(world, "POST", LOGIN, {}, { email: account.email, password: account.password, remember: false });
    const cookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
    await enrolSecondFactor(account.id);
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);
    const events = await instanceEvents();

    const response = await post(world, { cookie }, target.account.id, action);

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("reauth_required");
    expect(await accountState(target.account.id)).toMatchObject({ mfa: true, codes: 1 });
    expect(await statusOf(world, target.cookie)).toBe(200);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });
});

describe("the second-factor reset email", { timeout: TEST_TIMEOUT_MS }, () => {
  it.each(["en", "de"] as const)("is sent to the account in its language (%s), from a payload that holds identifiers only", async (locale) => {
    const world = harness.serve({ mail });
    const root = await admin(world);
    const target = await harness.person(world);
    await enrolSecondFactor(target.account.id);
    await setLocale(target.account.id, locale);

    expect((await post(world, root, target.account.id, "mfa-reset")).status).toBe(204);
    const queued = await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send' AND data->>'accountId' = ${target.account.id}`;
    expect(queued.map((job) => job.data)).toEqual([{ template: "mfaReset", accountId: target.account.id }]);
    await startWorker();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    expect(inbox.sent).toEqual([{ template: "mfaReset", to: target.account.email, locale, data: { displayName: "Grace Hopper" } }]);
  });
});
