import { CREDENTIAL_TOKEN_TTL_SECONDS, generateCredentialToken, type MailPort } from "@slugbase/core";
import { credentialTokenRepository } from "@slugbase/db";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import { invitationSendJob } from "../../src/worker/jobs/invitation-mail.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type World } from "../workspaces/support.ts";
import { createInvitation, GRANTED, freshAddress, invite, linkOf, signup, workspaceWithAdmin } from "./support.ts";

// Who proves the invited address when an invitation is accepted with registration fields (doc 02 sections 2.2 and
// 3.4, doc 10 T19). A token the invitation's mail job made reached the mailbox, so the account it creates is
// verified. A token an admin asked for as a copyable link did not, so the account it creates is not: it is made
// with the password the redeemer chose, and only the owner of the mailbox can verify it, which takes that password,
// the API tokens and the linked identities away. And a password reset ends the API tokens and the linked identities
// the account had before it.

const TEST_TIMEOUT_MS = 60_000;
const RESET = "/api/v1/auth/password/reset";
const NEW_PASSWORD = "the password chosen on the reset page";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
const noMail: MailPort = { available: false, send: () => Promise.resolve() };

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
  inbox.clear();
});

afterAll(() => harness.stop());

function serve(withMail: MailPort = mail): World {
  return harness.serve({
    entitlements: GRANTED,
    mail: withMail,
    env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", RATE_LIMIT_RESET_IP: "10000/hour", RATE_LIMIT_RESET_EMAIL: "10000/hour" },
  });
}

function jobContext(): ModuleContext {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const tenants = tenantDatabase(database());
  return { config, logger: recordingLogger(), adapters: { ...adapters(), mail }, withTenant: tenants.withTenant.bind(tenants) };
}

/** Runs the invitation's mail job and returns the token of the message it sent. */
async function mailedToken(workspaceId: string): Promise<string> {
  const jobs = await database().app<{ data: Record<string, unknown> }[]>`
    SELECT data FROM pgboss.job WHERE name = 'invitation.send' AND data->>'workspaceId' = ${workspaceId} ORDER BY created_on, id`;
  const job = jobs.at(-1);
  if (job === undefined) {
    throw new Error("no mail job was queued");
  }
  await invitationSendJob.handle(job.data, jobContext());
  const token = inbox.sent.at(-1)?.data["token"];
  if (typeof token !== "string") {
    throw new Error("the job sent no token");
  }
  return token;
}

interface AccountRow {
  readonly id: string;
  readonly verified: boolean;
}

async function accountOf(email: string): Promise<AccountRow | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`SELECT id, email_verified_at IS NOT NULL AS verified FROM accounts WHERE lower(email) = lower(${email})`;
  });
  return rows[0];
}

async function countOf(table: "api_tokens" | "account_identities", accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return table === "api_tokens"
      ? tx<{ count: number }[]>`SELECT count(*)::int AS count FROM api_tokens WHERE account_id = ${accountId}`
      : tx<{ count: number }[]>`SELECT count(*)::int AS count FROM account_identities WHERE account_id = ${accountId}`;
  });
  return rows[0]?.count ?? -1;
}

describe("the account an invitation with registration fields creates", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is not verified when the redeemed token is the link an admin asked for, and the invitation is still accepted into the workspace", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const email = freshAddress("held");
    const { token } = await invite(world, admin, email);

    const response = await signup(world, token);

    expect(response.status).toBe(201);
    const account = await accountOf(email);
    expect(account?.verified).toBe(false);
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [account?.id ?? ""]: "member" });
  });

  it("queues the verification email of the invited address, which is how its owner learns of the account and takes it over", async () => {
    const world = serve();
    const { admin } = await workspaceWithAdmin(harness, world);
    const email = freshAddress("held");
    const { token } = await invite(world, admin, email);

    expect((await signup(world, token)).status).toBe(201);

    const account = await accountOf(email);
    const jobs = await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send'`;
    expect(jobs.map((job) => job.data)).toEqual([expect.objectContaining({ template: "verifyEmail", accountId: account?.id })]);
  });

  it("queues no verification email where the deployment cannot send mail", async () => {
    const world = serve(noMail);
    const { admin } = await workspaceWithAdmin(harness, world);
    const { token } = await invite(world, admin, freshAddress("held"));

    expect((await signup(world, token)).status).toBe(201);

    const jobs = await database().app<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'mail.send'`;
    expect(jobs[0]?.count).toBe(0);
  });

  it("is verified when the redeemed token is the one the invitation's mail job sent", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const email = freshAddress("mailed");
    await createInvitation(world, admin, email);

    expect((await signup(world, await mailedToken(workspaceId))).status).toBe(201);

    expect((await accountOf(email))?.verified).toBe(true);
  });

  it("is verified for the token of a resend that followed a link, since the resend ended the link", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const email = freshAddress("resent");
    const id = await createInvitation(world, admin, email);
    const link = await linkOf(world, admin, id);
    expect((await send(world, "POST", `/api/v1/invitations/${id}/resend`, { cookie: admin.cookie })).status).toBe(200);

    expect((await signup(world, link)).status).toBe(410);
    expect((await signup(world, await mailedToken(workspaceId))).status).toBe(201);

    expect((await accountOf(email))?.verified).toBe(true);
  });

  it("stays unverified when the address is invited again where no mail can be sent, since that keeps the token the admin holds", async () => {
    const world = serve(noMail);
    const { admin } = await workspaceWithAdmin(harness, world);
    const email = freshAddress("again");
    const id = await createInvitation(world, admin, email);
    const link = await linkOf(world, admin, id);
    expect(await createInvitation(world, admin, email)).toBe(id);

    expect((await signup(world, link)).status).toBe(201);

    expect((await accountOf(email))?.verified).toBe(false);
  });
});

describe("a password reset", { timeout: TEST_TIMEOUT_MS }, () => {
  it("ends the API tokens and the linked identities the account had before it and leaves the second factor on", async () => {
    const world = serve();
    const person = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person, role: "owner" }]);
    const accountId = person.account.id;
    await harness.token(workspaceId, person, "read");
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${uuidv7()}, ${accountId}, 'idp', ${`subject-${accountId}`}, ${person.account.email})`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1', mfa_enabled_at = now() WHERE id = ${accountId}`;
    });
    expect(await countOf("api_tokens", accountId)).toBe(1);
    expect(await countOf("account_identities", accountId)).toBe(1);

    const token = generateCredentialToken();
    const issued = await tenantDatabase(database()).withTenant({ accountId, requestId: "invitation-link-verification-test" }, (tx) =>
      credentialTokenRepository(tx).issue({ id: uuidv7(), purpose: "password_reset", tokenHash: token.hash, targetEmail: null, ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS.password_reset }),
    );
    expect(issued).toBe(true);

    const response = await send(world, "POST", RESET, {}, { token: token.value, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(await countOf("api_tokens", accountId)).toBe(0);
    expect(await countOf("account_identities", accountId)).toBe(0);
    const factor = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ enabled: boolean }[]>`SELECT mfa_enabled_at IS NOT NULL AS enabled FROM accounts WHERE id = ${accountId}`;
    });
    expect(factor[0]?.enabled).toBe(true);
  });
});
