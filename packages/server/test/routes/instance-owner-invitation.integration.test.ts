import { hashCredentialToken, type MailMessage, type MailPort } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import { invitationSendJob } from "../../src/worker/jobs/invitation-mail.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { clearInstanceEvents, codeOf, enrolSecondFactor, instanceEvents, reauthenticate, signIn, signInAdmin } from "../instance/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, bearer, send, workspaceHarness, type World } from "../workspaces/support.ts";

// POST /instance/workspaces/{id}/owner-invitation, and the mailing of the owner invitation by it and by POST /instance/workspaces
// (doc 02 section 11.1, doc 04 section 10.10, doc 05 section 3.3, doc 10 T1 and T18). The failure scenario: an owner invitation
// whose link was lost or whose invitation expired leaves a workspace nobody can own, because no workspace admin exists to resend
// it; the instance admin issues a new one, the new link makes the invitee the owner and the old link no longer works. Also: a
// workspace with an owner, an unknown or deleted one, and a caller the instanceAdmin policy excludes or who has not
// re-authenticated, none of which changes anything; and a mailed invitation that returns no link, carries the token only in the
// message, and is sent by the invitation.send job as the admin acting in a workspace they are not a member of.

const WORKSPACES = "/api/v1/instance/workspaces";
const INVITATIONS = "/api/v1/invitations";
const MAIL_QUEUE = "invitation.send";
const LINK = /^https?:\/\/[^/]+\/invite\/([A-Za-z0-9_-]{43})$/;
const UNKNOWN_WORKSPACE = "0192f3a0-eeee-7000-8000-00000000dead";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message: MailMessage) => inbox.send(message) };

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_QUEUE}`;
  await clearInstanceEvents(database());
  inbox.clear();
});

interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly link: string | null;
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly mail_ticket: string | null;
  readonly token_hash: Buffer;
}

async function invitationsOf(workspaceId: string): Promise<InvitationRow[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return [...(await tx<InvitationRow[]>`SELECT id, email::text AS email, role::text AS role, status, mail_ticket::text AS mail_ticket, token_hash FROM workspace_invitations WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`)];
  });
}

async function expireInvitations(workspaceId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_invitations SET expires_at = now() - interval '1 hour' WHERE workspace_id = ${workspaceId}`;
  });
}

async function queuedMail(workspaceId: string): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${MAIL_QUEUE} AND data->>'workspaceId' = ${workspaceId} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

async function setLocale(accountId: string, locale: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET locale = ${locale} WHERE id = ${accountId}`;
  });
}

function jobContext(): ModuleContext {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const tenants = tenantDatabase(database());
  return { config, logger: recordingLogger(), adapters: { ...adapters(), mail }, withTenant: tenants.withTenant.bind(tenants) };
}

/** Runs the queued jobs of the workspace as the worker hands them over, once each. */
async function runMailJobs(workspaceId: string): Promise<void> {
  for (const data of await queuedMail(workspaceId)) {
    await invitationSendJob.handle(data, jobContext());
  }
}

const tokenOf = (link: string): string => LINK.exec(link)?.[1] ?? "";

async function createWaiting(world: World, cookie: string, ownerEmail: string): Promise<{ id: string; invitation: Invitation }> {
  const response = await send(world, "POST", WORKSPACES, { cookie }, { name: "Waiting", ownerEmail });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; ownerInvitation: Invitation };
  return { id: body.id, invitation: body.ownerInvitation };
}

const issue = (world: World, cookie: string, workspaceId: string, body: unknown = {}) => send(world, "POST", `${WORKSPACES}/${workspaceId}/owner-invitation`, { cookie }, body);

const accept = (world: World, cookie: string, token: string) => send(world, "POST", `${INVITATIONS}/accept`, { cookie }, { token });

describe("POST /instance/workspaces/{id}/owner-invitation where no mail is configured", () => {
  it("replaces an expired owner invitation: the new link makes the invitee the owner and the old link no longer works", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const invitee = await harness.person(world);
    const { id, invitation } = await createWaiting(world, root.cookie, invitee.account.email);
    const oldToken = tokenOf(invitation.link ?? "");
    await expireInvitations(id);
    expect((await accept(world, invitee.cookie, oldToken)).status).toBe(410);

    const response = await issue(world, root.cookie, id);

    expect(response.status).toBe(201);
    const issued = (await response.json()) as Invitation;
    expect(issued).toMatchObject({ email: invitee.account.email, link: expect.stringMatching(LINK) as string });
    expect(issued.id).not.toBe(invitation.id);
    expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    const newToken = tokenOf(issued.link ?? "");
    expect(newToken).not.toBe(oldToken);
    expect((await accept(world, invitee.cookie, oldToken)).status).toBe(410);
    expect(await harness.rolesOf(id)).toEqual({});

    const accepted = await accept(world, invitee.cookie, newToken);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId: id, role: "owner" });
    expect(await harness.rolesOf(id)).toEqual({ [invitee.account.id]: "owner" });
  });

  it("ends the link of a pending owner invitation at once and leaves one pending invitation, with only the hash of the new token stored", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const invitee = await harness.person(world);
    const { id, invitation } = await createWaiting(world, root.cookie, invitee.account.email);
    const oldToken = tokenOf(invitation.link ?? "");

    const issued = (await (await issue(world, root.cookie, id)).json()) as Invitation;

    expect((await accept(world, invitee.cookie, oldToken)).status).toBe(410);
    const rows = await invitationsOf(id);
    expect(rows.map((row) => [row.id, row.status, row.role])).toEqual([
      [invitation.id, "revoked", "owner"],
      [issued.id, "pending", "owner"],
    ]);
    expect(rows[1]?.token_hash.equals(hashCredentialToken(tokenOf(issued.link ?? "")) ?? Buffer.alloc(0))).toBe(true);
    expect(JSON.stringify(await instanceEvents(database()))).not.toContain(tokenOf(issued.link ?? ""));
  });

  it("invites the given address instead of the previous one, whose link ends, and writes one instance audit event naming no address", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const previous = await harness.person(world);
    const next = await harness.person(world);
    const { id, invitation } = await createWaiting(world, root.cookie, previous.account.email);
    await clearInstanceEvents(database());

    const response = await issue(world, root.cookie, id, { ownerEmail: next.account.email });

    expect(response.status).toBe(201);
    const issued = (await response.json()) as Invitation;
    expect(issued.email).toBe(next.account.email);
    expect((await accept(world, previous.cookie, tokenOf(invitation.link ?? ""))).status).toBe(410);
    expect((await accept(world, previous.cookie, tokenOf(issued.link ?? ""))).status).toBe(403);
    expect((await accept(world, next.cookie, tokenOf(issued.link ?? ""))).status).toBe(200);
    const events = await instanceEvents(database());
    expect(events).toEqual([expect.objectContaining({ action: "instance.workspace_owner_invited", actor_account_id: root.accountId, entity_id: id })]);
    expect(JSON.stringify(events)).not.toContain(next.account.email);
  });

  it("does not make the admin a member and queues no mail", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const { id } = await createWaiting(world, root.cookie, "waiting-owner@example.test");

    await issue(world, root.cookie, id);

    expect(await harness.rolesOf(id)).toEqual({});
    expect(await queuedMail(id)).toEqual([]);
  });

  it("answers 409 workspace_has_owner for a workspace that has an owner, and changes, writes and queues nothing", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const rows = await invitationsOf(workspaceId);

    const response = await issue(world, root.cookie, workspaceId, { ownerEmail: "someone@example.test" });

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("workspace_has_owner");
    expect(await invitationsOf(workspaceId)).toEqual(rows);
    expect(await instanceEvents(database())).toEqual([]);
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner" });
  });

  it("answers 409 once the invitation was accepted, and leaves the owner", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const invitee = await harness.person(world);
    const { id, invitation } = await createWaiting(world, root.cookie, invitee.account.email);
    expect((await accept(world, invitee.cookie, tokenOf(invitation.link ?? ""))).status).toBe(200);

    const response = await issue(world, root.cookie, id);

    expect(response.status).toBe(409);
    expect(await harness.rolesOf(id)).toEqual({ [invitee.account.id]: "owner" });
  });

  it("answers 404 for a workspace that does not exist or is being deleted, writing nothing", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const { id } = await createWaiting(world, root.cookie, "going@example.test");
    expect((await send(world, "DELETE", `${WORKSPACES}/${id}`, { cookie: root.cookie })).status).toBe(202);
    const rows = await invitationsOf(id);
    await clearInstanceEvents(database());

    for (const workspaceId of [id, UNKNOWN_WORKSPACE]) {
      const response = await issue(world, root.cookie, workspaceId, { ownerEmail: "x@example.test" });
      expect([response.status, await codeOf(response)]).toEqual([404, "not_found"]);
    }

    expect(await invitationsOf(id)).toEqual(rows);
    expect(await instanceEvents(database())).toEqual([]);
  });

  it("answers 422 owner_email_required when no address was given and the workspace has no owner invitation to take it from", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const workspaceId = (await harness.workspaceOf([])).workspaceId;

    const response = await issue(world, root.cookie, workspaceId);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "ownerEmail", code: "owner_email_required" }] });
    expect(await instanceEvents(database())).toEqual([]);
    expect((await issue(world, root.cookie, workspaceId, { ownerEmail: "first@example.test" })).status).toBe(201);
  });

  it.each([
    ["an address that is none", { ownerEmail: "not an address" }],
    ["a field the operation does not declare", { ownerEmail: "owner@example.test", role: "admin" }],
  ])("answers 422 for %s and changes nothing", async (_name, body) => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
    const rows = await invitationsOf(id);

    expect((await issue(world, root.cookie, id, body)).status).toBe(422);

    expect(await invitationsOf(id)).toEqual(rows);
  });

  it("answers 401 reauth_required to a session that has not re-authenticated within ten minutes, and changes nothing until it does", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const stale = await signInAdmin(database(), world, { reauth: false });
    const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
    const rows = await invitationsOf(id);

    const response = await issue(world, stale.cookie, id);

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("reauth_required");
    expect(await invitationsOf(id)).toEqual(rows);

    await reauthenticate(world, stale);
    expect((await issue(world, stale.cookie, id)).status).toBe(201);
  });

  describe("refuses everyone the instanceAdmin policy excludes, and changes nothing", () => {
    it("answers 401 without a credential", async () => {
      const world = harness.serve();
      const root = await signInAdmin(database(), world);
      const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
      const rows = await invitationsOf(id);

      const response = await send(world, "POST", `${WORKSPACES}/${id}/owner-invitation`, {}, {});

      expect([response.status, await codeOf(response)]).toEqual([401, "unauthenticated"]);
      expect(await invitationsOf(id)).toEqual(rows);
    });

    it("answers 403 forbidden to an account that holds no flag, even with a second factor and a fresh re-authentication", async () => {
      const world = harness.serve();
      const root = await signInAdmin(database(), world);
      const ordinary = await signIn(database(), world, { flag: false, mfa: true, reauth: true });
      const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
      const rows = await invitationsOf(id);
      await clearInstanceEvents(database());

      const response = await issue(world, ordinary.cookie, id, { ownerEmail: ordinary.email });

      expect([response.status, await codeOf(response)]).toEqual([403, "forbidden"]);
      expect(await invitationsOf(id)).toEqual(rows);
      expect(await instanceEvents(database())).toEqual([]);
    });

    it("answers 403 forbidden to an instance admin who has no second factor enrolled", async () => {
      const world = harness.serve();
      const root = await signInAdmin(database(), world);
      const withoutFactor = await signIn(database(), world, { flag: true, mfa: false, reauth: true });
      const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
      const rows = await invitationsOf(id);

      const response = await issue(world, withoutFactor.cookie, id);

      expect([response.status, await codeOf(response)]).toEqual([403, "forbidden"]);
      expect(await invitationsOf(id)).toEqual(rows);
    });

    it("answers 403 forbidden to an API token, even of an admin with a second factor", async () => {
      const world = harness.serve();
      const root = await signInAdmin(database(), world);
      const holder = await harness.person(world);
      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${holder.account.id}, true)`;
        await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${holder.account.id}`;
      });
      await enrolSecondFactor(database(), holder.account.id);
      const { workspaceId } = await harness.workspaceOf([{ person: holder, role: "owner" }]);
      const value = await harness.token(workspaceId, holder, "read-write");
      const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
      const rows = await invitationsOf(id);

      const response = await send(world, "POST", `${WORKSPACES}/${id}/owner-invitation`, bearer(value), {});

      expect([response.status, await codeOf(response)]).toEqual([403, "forbidden"]);
      expect(await invitationsOf(id)).toEqual(rows);
    });

    it("answers 403 from another origin", async () => {
      const world = harness.serve();
      const root = await signInAdmin(database(), world);
      const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
      const rows = await invitationsOf(id);

      const response = await world.server.fetch(
        new Request(new URL(`${WORKSPACES}/${id}/owner-invitation`, world.origin), {
          method: "POST",
          headers: { cookie: root.cookie, origin: "https://evil.example.test", "content-type": "application/json" },
          body: "{}",
        }),
      );

      expect(response.status).toBe(403);
      expect(await invitationsOf(id)).toEqual(rows);
    });
  });

  it("answers 403 forbidden, with nothing revoked or written, when the caller loses the flag after the policy admitted the request", async () => {
    const world = harness.serve();
    const root = await signInAdmin(database(), world);
    const { id } = await createWaiting(world, root.cookie, "waiting@example.test");
    const rows = await invitationsOf(id);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${root.accountId}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = false WHERE id = ${root.accountId}`;
    });

    const response = await issue(world, root.cookie, id);

    expect(response.status).toBe(403);
    expect(await invitationsOf(id)).toEqual(rows);
  });
});

describe("the owner invitation where mail is configured", () => {
  it("mails the invitation of POST /instance/workspaces in the language of the admin and returns no link; the message link makes the invitee the owner", async () => {
    const world = harness.serve({ mail });
    const root = await signInAdmin(database(), world);
    await setLocale(root.accountId, "de");
    const invitee = await harness.person(world);

    const created = await send(world, "POST", WORKSPACES, { cookie: root.cookie }, { name: "Mailed", ownerEmail: invitee.account.email });

    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; ownerInvitation: Invitation };
    expect(body.ownerInvitation).toMatchObject({ email: invitee.account.email, link: null });
    const [row] = await invitationsOf(body.id);
    expect(await queuedMail(body.id)).toEqual([
      { invitationId: row?.id, workspaceId: body.id, accountId: root.accountId, locale: "de", mailTicket: row?.id },
    ]);
    expect(inbox.sent).toEqual([]);

    await runMailJobs(body.id);

    expect(inbox.sent).toHaveLength(1);
    expect(inbox.sent[0]).toMatchObject({ template: "invitation", to: invitee.account.email, locale: "de", data: { workspaceName: "Mailed", role: "owner" } });
    const token = String(inbox.sent[0]?.data["token"]);
    expect((await invitationsOf(body.id))[0]?.token_hash.equals(hashCredentialToken(token) ?? Buffer.alloc(0))).toBe(true);
    expect(JSON.stringify([await database().owner`SELECT data FROM pgboss.job`, await instanceEvents(database())])).not.toContain(token);
    expect((await accept(world, invitee.cookie, token)).status).toBe(200);
    expect(await harness.rolesOf(body.id)).toEqual({ [invitee.account.id]: "owner" });
  });

  it("mails the new invitation of the operation, returns no link, and the job of the replaced invitation mails nothing", async () => {
    const world = harness.serve({ mail });
    const root = await signInAdmin(database(), world);
    const invitee = await harness.person(world);
    const { id } = await createWaiting(world, root.cookie, invitee.account.email);
    const [first] = await queuedMail(id);

    const response = await issue(world, root.cookie, id);

    expect(response.status).toBe(201);
    const issued = (await response.json()) as Invitation;
    expect(issued).toMatchObject({ email: invitee.account.email, link: null });
    expect(await queuedMail(id)).toEqual([
      first,
      { invitationId: issued.id, workspaceId: id, accountId: root.accountId, locale: "en", mailTicket: issued.id },
    ]);

    await runMailJobs(id);

    expect(inbox.sent).toHaveLength(1);
    expect(inbox.sent[0]).toMatchObject({ to: invitee.account.email, locale: "en", data: { role: "owner" } });
    const token = String(inbox.sent[0]?.data["token"]);
    const rows = await invitationsOf(id);
    expect(rows.map((row) => row.status)).toEqual(["revoked", "pending"]);
    expect(rows[1]?.token_hash.equals(hashCredentialToken(token) ?? Buffer.alloc(0))).toBe(true);
    expect((await accept(world, invitee.cookie, token)).status).toBe(200);
    expect(await harness.rolesOf(id)).toEqual({ [invitee.account.id]: "owner" });
  });

  it("queues no mail for a refusal", async () => {
    const world = harness.serve({ mail });
    const root = await signInAdmin(database(), world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);

    expect((await issue(world, root.cookie, workspaceId, { ownerEmail: "x@example.test" })).status).toBe(409);
    expect((await issue(world, root.cookie, UNKNOWN_WORKSPACE, { ownerEmail: "x@example.test" })).status).toBe(404);

    expect(await queuedMail(workspaceId)).toEqual([]);
    expect(await queuedMail(UNKNOWN_WORKSPACE)).toEqual([]);
  });

  it("queues no mail for a workspace created for an owner account", async () => {
    const world = harness.serve({ mail });
    const root = await signInAdmin(database(), world);
    const owner = await harness.person(world);

    const created = await send(world, "POST", WORKSPACES, { cookie: root.cookie }, { name: "Account owned", ownerAccountId: owner.account.id });

    expect(created.status).toBe(201);
    expect(((await created.json()) as { ownerInvitation: unknown }).ownerInvitation).toBeNull();
    expect(await database().owner`SELECT 1 FROM pgboss.job WHERE name = ${MAIL_QUEUE}`).toEqual([]);
  });
});
