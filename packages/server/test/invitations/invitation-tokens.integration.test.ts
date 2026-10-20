import { hashCredentialToken, type MailPort } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import { invitationSendJob } from "../../src/worker/jobs/invitation-mail.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import {
  acceptAs,
  createInvitation,
  inspect,
  invitationRow,
  invite,
  linkOf,
  resend,
  revoke,
  setExpiry,
  signup,
  GRANTED,
  workspaceWithAdmin,
  freshAddress,
} from "./support.ts";

// The invitation token through the whole chain over the migrated database (doc 02 section 3.4, doc 04 section 10.5,
// doc 05 section 3.3, doc 08 section 3.5, doc 10 T4 and T19). The failure scenarios: a token that works after its
// expiry, after the invitation was revoked or after a newer link replaced it; one that is accepted by an account
// whose verified address is not the invited one, an unverified account included; a membership with a role other
// than the invitation's or in another workspace; a token stored or logged in the clear, or a stored hash that is
// itself accepted as the token; and a resend or a link that leaves an earlier token working.
//
// Already asserted elsewhere, and not repeated here: a token that accepts at most once under parallel requests, in
// both forms (routes/invitation-acceptance, routes/invitation-signup); the role and workspace of a signed-in
// acceptance (routes/invitation-acceptance, "with exactly the invited role" and "grants the workspace of the
// invitation and no other"); the refusal of an account whose verified address is another (routes/invitation-acceptance,
// "invitation_email_mismatch"); the hash of a link or a resend against the stored one (routes/invitation-management).
// What this file adds: the expiry as the database clock judges it, revocation, the
// unverified account, the stored hash that must not redeem, the token in no store, and every earlier token refused
// through the inspection and the acceptance after each resend and link.

const TEST_TIMEOUT_MS = 60_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
  inbox.clear();
});

afterAll(() => harness.stop());

function serve(options: { readonly logger?: ReturnType<typeof recordingLogger> } = {}): World {
  return harness.serve({
    entitlements: GRANTED,
    mail,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", RATE_LIMIT_RESET_IP: "10000/hour", RATE_LIMIT_RESET_EMAIL: "10000/hour" },
  });
}

async function accountsWithEmail(email: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts WHERE lower(email) = lower(${email})`;
  });
  return rows[0]?.count ?? -1;
}

async function joinedJobs(workspaceId: string): Promise<number> {
  const rows = await database().app<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'event.member.joined' AND data->>'workspaceId' = ${workspaceId}`;
  return rows[0]?.count ?? -1;
}

/** Every token-dependent answer of the three redemptions for `token`. */
async function statuses(world: World, token: string, person: Person): Promise<number[]> {
  return [(await inspect(world, token)).status, (await acceptAs(world, person, token)).status, (await signup(world, token)).status];
}

describe("the 7-day expiry of an invitation token", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is set seven days from the database's now by the create, the link and the resend, and an inspection or a refused acceptance does not move it", async () => {
    const world = serve();
    const { admin } = await workspaceWithAdmin(harness, world);
    const email = freshAddress();
    const id = await createInvitation(world, admin, email);
    expect(Math.abs((await invitationRow(database(), id)).seconds_to_expiry - WEEK_SECONDS)).toBeLessThan(120);

    await setExpiry(database(), id, 3600);
    const token = await linkOf(world, admin, id);
    expect(Math.abs((await invitationRow(database(), id)).seconds_to_expiry - WEEK_SECONDS)).toBeLessThan(120);

    await setExpiry(database(), id, 3600);
    expect((await resend(world, admin, id)).status).toBe(200);
    expect(Math.abs((await invitationRow(database(), id)).seconds_to_expiry - WEEK_SECONDS)).toBeLessThan(120);

    // The resend replaced the token the link made, and neither request nor refusal extends the expiry.
    await setExpiry(database(), id, 3600);
    const stranger = await harness.person(world);
    expect((await inspect(world, token)).status).toBe(410);
    expect((await acceptAs(world, stranger, token)).status).toBe(410);
    expect((await invitationRow(database(), id)).seconds_to_expiry).toBeLessThanOrEqual(3600);
  });

  it("accepts a token before the database clock passes its expiry and refuses it after, to the inspection and to both forms of the acceptance, writing nothing", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const live = await invite(world, admin, holder.account.email);
    await setExpiry(database(), live.id, 30);
    expect((await inspect(world, live.token)).status).toBe(200);

    const late = await harness.person(world);
    const expiring = await invite(world, admin, late.account.email);
    const unknown = freshAddress("noaccount");
    const forNobody = await invite(world, admin, unknown);
    await setExpiry(database(), expiring.id, -1);
    await setExpiry(database(), forNobody.id, -1);
    const before = await harness.rolesOf(workspaceId);

    expect(await statuses(world, expiring.token, late)).toEqual([410, 410, 410]);
    expect((await signup(world, forNobody.token)).status).toBe(410);
    expect((await inspect(world, forNobody.token)).status).toBe(410);

    expect(await harness.rolesOf(workspaceId)).toEqual(before);
    expect(await accountsWithEmail(unknown)).toBe(0);
    expect(await joinedJobs(workspaceId)).toBe(0);
    expect(await invitationRow(database(), expiring.id)).toMatchObject({ status: "pending", accepted_by: null });
    // The one that has not expired still accepts.
    expect((await acceptAs(world, holder, live.token)).status).toBe(200);
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [holder.account.id]: "member" });
  });

  it("works again from a new link after the expiry: the expired token stays refused and the new one is accepted", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const issued = await invite(world, admin, holder.account.email, "admin");
    await setExpiry(database(), issued.id, -1);
    expect((await acceptAs(world, holder, issued.token)).status).toBe(410);

    const renewed = await linkOf(world, admin, issued.id);

    expect((await acceptAs(world, holder, issued.token)).status).toBe(410);
    expect((await acceptAs(world, holder, renewed)).status).toBe(200);
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [holder.account.id]: "admin" });
  });
});

describe("the revocation of an invitation", { timeout: TEST_TIMEOUT_MS }, () => {
  it("refuses the token of a revoked invitation to the inspection and to both forms of the acceptance, writes no membership and no account, and leaves the invitation revoked", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const known = await invite(world, admin, holder.account.email);
    const nobody = freshAddress("noaccount");
    const unknown = await invite(world, admin, nobody);
    const before = await harness.rolesOf(workspaceId);
    expect((await revoke(world, admin, known.id)).status).toBe(204);
    expect((await revoke(world, admin, unknown.id)).status).toBe(204);

    expect(await statuses(world, known.token, holder)).toEqual([410, 410, 410]);
    expect(await statuses(world, unknown.token, holder)).toEqual([410, 410, 410]);

    expect(await harness.rolesOf(workspaceId)).toEqual(before);
    expect(await accountsWithEmail(nobody)).toBe(0);
    expect(await joinedJobs(workspaceId)).toBe(0);
    expect(await invitationRow(database(), known.id)).toMatchObject({ status: "revoked", accepted_by: null });
    expect(await invitationRow(database(), unknown.id)).toMatchObject({ status: "revoked", accepted_by: null });
  });

  it("leaves an accepted invitation accepted: revoking it is 404 and the membership stays", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const issued = await invite(world, admin, holder.account.email);
    expect((await acceptAs(world, holder, issued.token)).status).toBe(200);

    const revoked = await revoke(world, admin, issued.id);

    expect(revoked.status).toBe(404);
    expect(await invitationRow(database(), issued.id)).toMatchObject({ status: "accepted", accepted_by: holder.account.id });
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [holder.account.id]: "member" });
  });
});

describe("the account that accepts", { timeout: TEST_TIMEOUT_MS }, () => {
  /** Ends the verification of the account's address, as an address that was changed and not yet confirmed would. */
  async function unverify(accountId: string): Promise<void> {
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      await tx`UPDATE accounts SET email_verified_at = NULL WHERE id = ${accountId}`;
    });
  }

  async function verify(accountId: string): Promise<void> {
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      await tx`UPDATE accounts SET email_verified_at = now() WHERE id = ${accountId}`;
    });
  }

  it("refuses an account that holds the invited address without having verified it with 403 invitation_email_mismatch, writing nothing, and accepts it once it is verified", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const issued = await invite(world, admin, holder.account.email);
    await unverify(holder.account.id);
    const before = await harness.rolesOf(workspaceId);

    const refused = await acceptAs(world, holder, issued.token);

    expect(refused.status).toBe(403);
    const problem = (await refused.json()) as { code: string; errors?: { path: string; code: string }[] };
    expect(problem.code).toBe("forbidden");
    expect(problem.errors).toEqual([{ path: "token", code: "invitation_email_mismatch" }]);
    expect(await harness.rolesOf(workspaceId)).toEqual(before);
    expect(await invitationRow(database(), issued.id)).toMatchObject({ status: "pending", accepted_by: null });
    expect(await joinedJobs(workspaceId)).toBe(0);
    // The token is not used up by the refusal.
    expect((await inspect(world, issued.token)).status).toBe(200);

    await verify(holder.account.id);
    expect((await acceptAs(world, holder, issued.token)).status).toBe(200);
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [holder.account.id]: "member" });
  });

  it("refuses a verified account of another address and leaves the token for the invited one, whatever the case the address was invited in", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const stranger = await harness.person(world);
    const issued = await invite(world, admin, holder.account.email.toUpperCase());

    const refused = await acceptAs(world, stranger, issued.token);

    expect(refused.status).toBe(403);
    expect(await harness.rolesOf(workspaceId)).not.toHaveProperty(stranger.account.id);
    expect((await acceptAs(world, holder, issued.token)).status).toBe(200);
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [holder.account.id]: "member" });
  });
});

describe("the role and the workspace of the membership", { timeout: TEST_TIMEOUT_MS }, () => {
  it("gives each invitation of one account its own workspace and its own role, whichever is accepted first and whichever the session acts in", async () => {
    const world = serve();
    const first = await workspaceWithAdmin(harness, world);
    const second = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const asAdmin = await invite(world, first.admin, holder.account.email, "admin");
    const asMember = await invite(world, second.admin, holder.account.email, "member");

    const secondAccepted = await acceptAs(world, holder, asMember.token);
    expect(secondAccepted.status).toBe(200);
    expect(await secondAccepted.json()).toEqual({ workspaceId: second.workspaceId, role: "member" });
    expect(await harness.rolesOf(first.workspaceId)).not.toHaveProperty(holder.account.id);

    const firstAccepted = await acceptAs(world, holder, asAdmin.token);
    expect(firstAccepted.status).toBe(200);
    expect(await firstAccepted.json()).toEqual({ workspaceId: first.workspaceId, role: "admin" });
    expect((await harness.rolesOf(first.workspaceId))[holder.account.id]).toBe("admin");
    expect((await harness.rolesOf(second.workspaceId))[holder.account.id]).toBe("member");
  });

  it("gives the account created by an acceptance exactly the invited role, member or admin, in the invited workspace only", async () => {
    const world = serve();
    const first = await workspaceWithAdmin(harness, world);
    const second = await workspaceWithAdmin(harness, world);
    const member = await invite(world, first.admin, freshAddress("newmember"), "member");
    const admin = await invite(world, second.admin, freshAddress("newadmin"), "admin");

    const memberAccepted = await signup(world, member.token);
    const adminAccepted = await signup(world, admin.token);

    expect(await memberAccepted.json()).toEqual({ workspaceId: first.workspaceId, role: "member" });
    expect(await adminAccepted.json()).toEqual({ workspaceId: second.workspaceId, role: "admin" });
    expect(Object.values(await harness.rolesOf(first.workspaceId)).sort()).toEqual(["admin", "member", "owner"]);
    expect(Object.values(await harness.rolesOf(second.workspaceId)).sort()).toEqual(["admin", "admin", "owner"]);
  });
});

describe("the token as a credential", { timeout: TEST_TIMEOUT_MS }, () => {
  it("stores only the SHA-256 of the token: the hash is 32 bytes, is not the token and does not contain it", async () => {
    const world = serve();
    const { admin } = await workspaceWithAdmin(harness, world);
    const issued = await invite(world, admin, freshAddress());

    const row = await invitationRow(database(), issued.id);

    expect(row.token_hash).toHaveLength(32);
    expect(row.token_hash.equals(hashCredentialToken(issued.token) ?? Buffer.alloc(0))).toBe(true);
    expect(row.token_hash.equals(Buffer.from(issued.token, "base64url"))).toBe(false);
    const stored = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ text: string }[]>`SELECT i::text AS text FROM workspace_invitations i WHERE i.id = ${issued.id}`;
    });
    expect(stored[0]?.text).not.toContain(issued.token);
  });

  it("does not accept the stored hash as the token, in either spelling, to the inspection or to either form of the acceptance", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const known = await invite(world, admin, holder.account.email);
    const nobody = freshAddress("noaccount");
    const unknown = await invite(world, admin, nobody);
    const before = await harness.rolesOf(workspaceId);

    for (const { id } of [known, unknown]) {
      const { token_hash: hash } = await invitationRow(database(), id);
      for (const spelling of [hash.toString("base64url"), hash.toString("hex"), hash.toString("base64")]) {
        expect(await statuses(world, spelling, holder), `${id} as ${spelling}`).toEqual([410, 410, 410]);
      }
    }

    expect(await harness.rolesOf(workspaceId)).toEqual(before);
    expect(await accountsWithEmail(nobody)).toBe(0);
    expect(await invitationRow(database(), known.id)).toMatchObject({ status: "pending" });
    // The tokens themselves still work.
    expect((await inspect(world, known.token)).status).toBe(200);
    expect((await inspect(world, unknown.token)).status).toBe(200);
  });

  it("is in no response, audit event, queued job or log line after the inspection and both forms of the acceptance", async () => {
    const logger = recordingLogger();
    const world = serve({ logger });
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const known = await invite(world, admin, holder.account.email);
    const created = await invite(world, admin, freshAddress("newperson"));
    const answers: string[] = [];

    for (const response of [
      await inspect(world, known.token),
      await acceptAs(world, holder, known.token),
      await inspect(world, created.token),
      await signup(world, created.token),
      await inspect(world, known.token),
      await signup(world, known.token),
    ]) {
      answers.push(await response.text());
    }

    expect(await joinedJobs(workspaceId)).toBe(2);
    const audit = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ text: string }[]>`SELECT row_to_json(a)::text AS text FROM audit_events a WHERE a.workspace_id = ${workspaceId}`;
    });
    expect(audit.length).toBeGreaterThan(0);
    const jobs = await database().owner`SELECT data FROM pgboss.job`;
    const everywhere = JSON.stringify([answers, audit, jobs, logger.entries, logger.requests]);
    for (const { token } of [known, created]) {
      expect(everywhere).not.toContain(token);
    }
  });
});

describe("a resend and a link end the earlier tokens", { timeout: TEST_TIMEOUT_MS }, () => {
  function jobContext(): ModuleContext {
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
    const tenants = tenantDatabase(database());
    return { config, logger: recordingLogger(), adapters: { ...adapters(), mail }, withTenant: tenants.withTenant.bind(tenants) };
  }

  /** Runs the mail jobs queued so far that have not run, as the worker would hand them over, and returns the token of the message the last one sent. */
  async function deliver(workspaceId: string, ran: { count: number }): Promise<string> {
    const jobs = await database().app<{ data: Record<string, unknown> }[]>`
      SELECT data FROM pgboss.job WHERE name = 'invitation.send' AND data->>'workspaceId' = ${workspaceId} ORDER BY created_on, id`;
    expect(jobs.length).toBeGreaterThan(ran.count);
    for (const job of jobs.slice(ran.count)) {
      await invitationSendJob.handle(job.data, jobContext());
    }
    ran.count = jobs.length;
    const token = inbox.sent.at(-1)?.data["token"];
    if (typeof token !== "string") {
      throw new Error("the job sent no token");
    }
    return token;
  }

  it("refuses every earlier token to the inspection and to the acceptance after each resend and each link, whichever of the two made it, and accepts the latest once", async () => {
    const world = serve();
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const holder = await harness.person(world);
    const id = await createInvitation(world, admin, holder.account.email, "admin");
    const ran = { count: 0 };
    const issued: string[] = [await deliver(workspaceId, ran)];

    const steps: readonly (readonly [string, () => Promise<string>])[] = [
      ["a link after the mail", () => linkOf(world, admin, id)],
      ["a resend after the link", async () => {
        expect((await resend(world, admin, id)).status).toBe(200);
        return deliver(workspaceId, ran);
      }],
      ["a second resend", async () => {
        expect((await resend(world, admin, id)).status).toBe(200);
        return deliver(workspaceId, ran);
      }],
      ["a link after a resend", () => linkOf(world, admin, id)],
      ["a second link", () => linkOf(world, admin, id)],
    ];
    for (const [name, step] of steps) {
      issued.push(await step());
      const latest = issued.at(-1) ?? "";
      expect(new Set(issued).size, name).toBe(issued.length);
      for (const earlier of issued.slice(0, -1)) {
        expect((await inspect(world, earlier)).status, `${name}: inspecting an earlier token`).toBe(410);
        expect((await acceptAs(world, holder, earlier)).status, `${name}: accepting an earlier token`).toBe(410);
        expect((await signup(world, earlier)).status, `${name}: creating an account with an earlier token`).toBe(410);
      }
      expect((await inspect(world, latest)).status, `${name}: inspecting the latest token`).toBe(200);
      expect((await invitationRow(database(), id)).token_hash.equals(hashCredentialToken(latest) ?? Buffer.alloc(0)), name).toBe(true);
    }

    expect(await harness.rolesOf(workspaceId)).not.toHaveProperty(holder.account.id);
    expect((await acceptAs(world, holder, issued.at(-1) ?? "")).status).toBe(200);
    expect(await harness.rolesOf(workspaceId)).toMatchObject({ [holder.account.id]: "admin" });
    for (const token of issued) {
      expect((await acceptAs(world, holder, token)).status).toBe(410);
    }
  });
});
