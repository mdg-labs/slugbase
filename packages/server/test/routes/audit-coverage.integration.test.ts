import { archiveBookmarks, AUDIT_ACTIONS, AUDIT_ACTION_NAMES, restoreBookmarks, type MailPort } from "@slugbase/core";
import { bookmarkArchiveTransaction } from "@slugbase/db";
import { FakeIdentity, InMemoryMail, LimitedEntitlementSource, type FakeIdentityGrant } from "@slugbase/testing";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { classifyOperations, loadOpenApiDocument } from "@slugbase/testing/tenancy";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { tenantDatabase } from "../contract/support.ts";
import { signInAdmin } from "../instance/support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { ACTIVE_WORKSPACE, HOOK_TIMEOUT_MS, LEAVE, MEMBERS, SETTINGS, TRANSFER, WORKSPACE, WORKSPACES, send, workspaceHarness, type Person } from "../workspaces/support.ts";

// Doc 02 section 10 promises that every recorded workspace action is recorded exactly once, from one catalog of dotted action names. The script below
// performs one successful request for each audited operation through the whole chain over the migrated database, states for each step the events it adds
// to the logs (the action, the actor and the name it had at the time, the entity, the metadata) and then compares the actions it saw with
// `AUDIT_ACTION_NAMES` in both directions: a catalog action that no step writes fails the suite by name, and so does an event of a workspace whose action
// the catalog does not hold. The failure scenarios are reproduced at the steps that raise them: a bulk delete of ten bookmarks records one event with the
// count and nothing of the bookmarks; a share records the target's name and the identifier of what was shared and no address, title or URL; a repeat that
// changes nothing records nothing; and sign-ins and API tokens, which are account security events, are in no log. The log is then read through
// GET /api/v1/audit-events as the owner reads it and has to hold what the script saw. The archive services, which a composition's job calls and which no
// operation of CE reaches, are driven the way `bookmark-archive.integration.test.ts` drives them.

const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TEAMS = "/api/v1/teams";
const INVITATIONS = "/api/v1/invitations";
const AUDIT = "/api/v1/audit-events";
const TOKENS = "/api/v1/me/api-tokens";
const PASSWORD = "correct horse battery staple 42";
const ISSUER = "https://idp.example.test";
const PREAUTH_COOKIE = "__Host-slugbase_oidc";
const NAME = "Test account";
const TITLE = "A private title of the owner";
const HOST = "example.com";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(() => assertBookmarkCountMatches(database()));

interface EventRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly action: string;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly actor_label: string;
  readonly actor_token_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly metadata: Record<string, string>;
  /** The whole row as text, to look in it for what it must not hold. */
  readonly row: string;
}

/** Every audit event of the deployment, the logs of the workspaces and the instance stream, oldest first, read as the system role. */
async function allEvents(): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`
      SELECT id, workspace_id, action, actor_type::text AS actor_type, actor_account_id, actor_label, actor_token_id, entity_type, entity_id, metadata, e::text AS row
      FROM audit_events e ORDER BY created_at, id`;
  });
  return [...rows];
}

async function accountHolding(email: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM accounts WHERE email = ${email}`;
  });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("no account holds the address");
  }
  return id;
}

async function teamsOf(accountId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ team_id: string }[]>`SELECT team_id FROM team_members WHERE account_id = ${accountId}`;
  });
  return rows.map((row) => row.team_id);
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*);`).exec(header);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

async function idOf(response: Response): Promise<string> {
  return ((await response.clone().json()) as { id: string }).id;
}

const tokenOf = async (response: Response): Promise<string> => new URL(((await response.clone().json()) as { link: string }).link).pathname.split("/").at(-1) ?? "";

interface Actor {
  /** The account that acted, or `system` for the job of a composition. */
  readonly accountId: string;
  /** The name the account had when it acted. */
  readonly label?: string;
}

interface Expected {
  readonly action: string;
  /** The log the event is in: a workspace, or null for the instance stream. */
  readonly workspaceId: string | null;
  readonly entity: { readonly type: string; readonly id: string } | null;
  readonly metadata: Record<string, string>;
}

type Later<T> = T | (() => T | Promise<T>);

interface Step {
  /** The operation of `openapi.json` the request calls; absent for a call of a service that no operation reaches. */
  readonly operationId?: string;
  /** Names a step in a failure when the operation has several. */
  readonly label?: string;
  /** Who acted, read once the call has answered, for an account the call created. */
  readonly actor: Later<Actor>;
  readonly status?: number;
  readonly call: () => Promise<Response | undefined>;
  /** The events the call adds, in any order; a repeat that changes nothing adds none. Read once the call has answered, for the identifiers it created. */
  readonly events: Later<readonly Expected[]>;
  /** Looked at with the rows the call wrote, for what they must not hold. */
  readonly check?: (written: readonly EventRow[]) => void | Promise<void>;
}

const resolved = async <T>(value: Later<T>): Promise<T> => (typeof value === "function" ? (value as () => T | Promise<T>)() : value);

describe("the audit log of a workspace", () => {
  it(
    "holds one event for each action of the catalog that an operation of doc 02 section 10 records, and the script of operations covers the whole catalog",
    async () => {
      const fake = new FakeIdentity({ providers: [{ id: "idp", displayName: "Example IdP", issuer: ISSUER, clientId: "client-id-1" }] });
      const world = harness.serve({
        mail,
        allowWorkspaceCreation: true,
        entitlementSource: new LimitedEntitlementSource(),
        identity: { available: true, listProviders: () => fake.listProviders(), begin: (request) => fake.begin(request), complete: (request) => fake.complete(request) },
        secretBox: testSecretBox(testKey("audit-coverage")),
        env: {
          OIDC_IDP_CLIENT_ID: "client-id-1",
          OIDC_IDP_CLIENT_SECRET: "a-client-secret",
          OIDC_IDP_ISSUER_URL: ISSUER,
          RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour",
          RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour",
          RATE_LIMIT_BULK_IP: "10000/hour",
          RATE_LIMIT_BULK_ACCOUNT: "10000/hour",
        },
      });

      const owner = await harness.person(world);
      const member = await harness.person(world);
      const removed = await harness.person(world);
      const leaver = await harness.person(world);
      const invitee = await harness.person(world);
      const creator = await harness.person(world);
      const root = await signInAdmin(database(), world);
      const { workspaceId } = await harness.workspaceOf([
        { person: owner, role: "owner" },
        { person: member, role: "member" },
        { person: removed, role: "member" },
        { person: leaver, role: "member" },
      ]);
      const as = (person: Person): Actor => ({ accountId: person.account.id, label: NAME });
      const cookie = (person: Person) => ({ cookie: person.cookie });
      const post = (person: Person, path: string, body?: unknown) => send(world, "POST", path, cookie(person), body);

      const operations = new Set(classifyOperations(loadOpenApiDocument()).operations.map((operation) => operation.operationId));
      const ran: string[] = [];
      const seen = new Set<string>();
      const outsideCatalog: string[] = [];

      async function run(step: Step): Promise<Response | undefined> {
        const label = step.label ?? step.operationId ?? "a service call";
        if (step.operationId !== undefined) {
          ran.push(step.operationId);
        }
        const before = new Set((await allEvents()).map((event) => event.id));
        const response = await step.call();
        if (step.status !== undefined) {
          expect(response?.status, label).toBe(step.status);
        }
        const written = (await allEvents()).filter((event) => !before.has(event.id));
        const expected = await resolved(step.events);
        const actor = await resolved(step.actor);
        expect(written.map((event) => event.action).sort(), label).toEqual(expected.map((event) => event.action).sort());
        for (const event of expected) {
          const row = written.find((candidate) => candidate.action === event.action);
          if (row === undefined) {
            throw new Error(`${label}: ${event.action} was not written`);
          }
          const where = `${label}: ${event.action}`;
          expect(row.workspace_id, `${where} log`).toBe(event.workspaceId);
          if (event.workspaceId === null) {
            // An event of the instance stream: who acted and what it acted on.
            expect([row.actor_account_id, row.entity_id], where).toEqual([actor.accountId, event.entity?.id]);
            continue;
          }
          if (actor.accountId === "system") {
            expect([row.actor_type, row.actor_account_id, row.actor_token_id], `${where} actor`).toEqual(["system", null, null]);
          } else {
            expect([row.actor_type, row.actor_account_id, row.actor_token_id], `${where} actor`).toEqual(["account", actor.accountId, null]);
          }
          if (actor.label !== undefined) {
            expect(row.actor_label, `${where} actor label`).toBe(actor.label);
          }
          expect(row.entity_type === null ? null : { type: row.entity_type, id: row.entity_id }, `${where} entity`).toEqual(event.entity);
          expect(row.metadata, `${where} metadata`).toEqual(event.metadata);
          // The metadata holds the fields the catalog declares for the action, and no other.
          expect(Object.keys(row.metadata).sort(), `${where} metadata fields`).toEqual(Object.keys(AUDIT_ACTIONS[event.action as keyof typeof AUDIT_ACTIONS].metadata).sort());
        }
        for (const row of written) {
          if (row.workspace_id !== null) {
            seen.add(row.action);
            if (!(AUDIT_ACTION_NAMES as readonly string[]).includes(row.action)) {
              outsideCatalog.push(row.action);
            }
          }
        }
        await step.check?.(written);
        return response;
      }

      const inWorkspace = (id: string, action: string, entity: Expected["entity"], metadata: Record<string, string>): Expected => ({ action, workspaceId: id, entity, metadata });
      const event = (action: string, entity: Expected["entity"], metadata: Record<string, string>): Expected => inWorkspace(workspaceId, action, entity, metadata);
      const forMember = (action: string, accountId: string, metadata: Record<string, string>): Expected => event(action, { type: "member", id: accountId }, metadata);

      // The workspace: a rename and a setting, each repeated to the value it has, which records nothing.
      await run({
        operationId: "renameWorkspace",
        actor: as(owner),
        status: 200,
        call: () => send(world, "PATCH", WORKSPACE, cookie(owner), { name: "Audit coverage" }),
        events: [event("workspace.renamed", { type: "workspace", id: workspaceId }, { from: "Authorization suite", to: "Audit coverage" })],
      });
      await run({ label: "renameWorkspace to its own name", operationId: "renameWorkspace", actor: as(owner), status: 200, call: () => send(world, "PATCH", WORKSPACE, cookie(owner), { name: "Audit coverage" }), events: [] });
      await run({
        operationId: "updateWorkspaceSettings",
        actor: as(owner),
        status: 200,
        call: () => send(world, "PATCH", SETTINGS, cookie(owner), { aiEnabled: false }),
        events: [event("workspace.settings_changed", { type: "workspace", id: workspaceId }, { setting: "aiEnabled", from: "true", to: "false" })],
      });
      await run({ label: "updateWorkspaceSettings to its own value", operationId: "updateWorkspaceSettings", actor: as(owner), status: 200, call: () => send(world, "PATCH", SETTINGS, cookie(owner), { aiEnabled: false }), events: [] });

      // Teams: created, renamed, given members, and one deleted.
      let team = "";
      let temporary = "";
      await run({
        operationId: "createTeam",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, TEAMS, { name: "Design" });
          team = await idOf(response);
          return response;
        },
        events: () => [event("team.created", { type: "team", id: team }, { name: "Design" })],
      });
      await run({
        operationId: "updateTeam",
        actor: as(owner),
        status: 200,
        call: () => send(world, "PATCH", `${TEAMS}/${team}`, cookie(owner), { name: "Design team" }),
        events: () => [event("team.updated", { type: "team", id: team }, { from: "Design", to: "Design team" })],
      });
      await run({
        operationId: "replaceTeamMembers",
        actor: as(owner),
        status: 200,
        call: () => send(world, "PUT", `${TEAMS}/${team}/members`, cookie(owner), { accountIds: [member.account.id] }),
        events: () => [event("team.members_changed", { type: "team", id: team }, { name: "Design team" })],
      });
      await run({
        operationId: "createTeam",
        label: "createTeam, the one that is deleted",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, TEAMS, { name: "Temporary" });
          temporary = await idOf(response);
          return response;
        },
        events: () => [event("team.created", { type: "team", id: temporary }, { name: "Temporary" })],
      });
      await run({
        operationId: "deleteTeam",
        actor: as(owner),
        status: 204,
        call: () => send(world, "DELETE", `${TEAMS}/${temporary}`, cookie(owner)),
        events: () => [event("team.deleted", { type: "team", id: temporary }, { name: "Temporary" })],
      });

      // Invitations: one for an account that exists (A), one for an address with no account (B, who registers), one that a provider accepts (C), and one that is revoked (D).
      const idpEmail = "idp-person@example.test";
      const newEmail = "new-person@example.test";
      let invitationA = "";
      let invitationB = "";
      let invitationC = "";
      let invitationD = "";
      const forInvitation = (action: string, id: () => string, role: string): Later<readonly Expected[]> => () => [event(action, { type: "invitation", id: id() }, { role })];
      await run({
        operationId: "createInvitation",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, INVITATIONS, { email: invitee.account.email, role: "member", teamIds: [team] });
          invitationA = await idOf(response);
          return response;
        },
        events: forInvitation("invitation.created", () => invitationA, "member"),
      });
      await run({
        operationId: "createInvitation",
        label: "createInvitation for an address with a pending invitation",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, INVITATIONS, { email: invitee.account.email, role: "member", teamIds: [team] });
          expect(await idOf(response)).toBe(invitationA);
          return response;
        },
        events: forInvitation("invitation.resent", () => invitationA, "member"),
      });
      await run({
        operationId: "createInvitation",
        label: "createInvitation for the address that registers",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, INVITATIONS, { email: newEmail, role: "admin" });
          invitationB = await idOf(response);
          return response;
        },
        events: forInvitation("invitation.created", () => invitationB, "admin"),
      });
      await run({
        operationId: "resendInvitation",
        actor: as(owner),
        status: 200,
        call: () => post(owner, `${INVITATIONS}/${invitationB}/resend`),
        events: forInvitation("invitation.resent", () => invitationB, "admin"),
      });
      await run({
        operationId: "createInvitation",
        label: "createInvitation for the address a provider accepts",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, INVITATIONS, { email: idpEmail, role: "member" });
          invitationC = await idOf(response);
          return response;
        },
        events: forInvitation("invitation.created", () => invitationC, "member"),
      });
      await run({
        operationId: "createInvitation",
        label: "createInvitation for the one that is revoked",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, INVITATIONS, { email: "revoked-person@example.test", role: "member" });
          invitationD = await idOf(response);
          return response;
        },
        events: forInvitation("invitation.created", () => invitationD, "member"),
      });
      await run({
        operationId: "revokeInvitation",
        actor: as(owner),
        status: 204,
        call: () => send(world, "DELETE", `${INVITATIONS}/${invitationD}`, cookie(owner)),
        events: forInvitation("invitation.revoked", () => invitationD, "member"),
      });
      const tokens: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
      for (const [letter, id, role] of [
        ["A", () => invitationA, "member"],
        ["B", () => invitationB, "admin"],
        ["C", () => invitationC, "member"],
      ] as const) {
        await run({
          operationId: "createInvitationLink",
          label: `createInvitationLink for invitation ${letter}`,
          actor: as(owner),
          status: 200,
          call: async () => {
            const response = await post(owner, `${INVITATIONS}/${id()}/link`);
            tokens[letter] = await tokenOf(response);
            return response;
          },
          events: forInvitation("invitation.link_created", id, role),
        });
      }

      // The three ways an invitation is accepted, each recorded as the account joining and nothing else: the teams the invitation names are joined with it.
      await run({
        operationId: "acceptInvitation",
        label: "acceptInvitation signed in",
        actor: as(invitee),
        status: 200,
        call: () => post(invitee, `${INVITATIONS}/accept`, { token: tokens.A }),
        events: () => [forMember("member.joined", invitee.account.id, { role: "member" })],
      });
      expect(await teamsOf(invitee.account.id), "the invitation's team is joined as part of the acceptance").toEqual([team]);
      await run({
        operationId: "acceptInvitation",
        label: "acceptInvitation with a new account",
        actor: async () => ({ accountId: await accountHolding(newEmail), label: "Grace Hopper" }),
        status: 201,
        call: () => send(world, "POST", `${INVITATIONS}/accept`, {}, { token: tokens.B, displayName: "Grace Hopper", password: PASSWORD }),
        events: async () => [forMember("member.joined", await accountHolding(newEmail), { role: "admin" })],
      });
      const grant: FakeIdentityGrant = { subject: "idp-subject", email: idpEmail, emailVerified: true, displayName: "Ada Provider" };
      ran.push("startOidcSignIn");
      await run({
        operationId: "completeOidcSignIn",
        label: "acceptInvitation through the identity provider",
        actor: async () => ({ accountId: await accountHolding(idpEmail), label: "Ada Provider" }),
        status: 302,
        call: async () => {
          const started = await world.server.fetch(
            new Request(new URL(`/api/v1/auth/oidc/idp/start?intent=invite&invitation=${tokens.C}&returnTo=/`, world.origin), { headers: { "sec-fetch-site": "same-origin" } }),
          );
          const preAuth = cookieValue(started, PREAUTH_COOKIE);
          expect(started.status).toBe(302);
          expect(preAuth).toBeDefined();
          const callbackUrl = fake.approve(started.headers.get("location") ?? "", grant);
          return world.server.fetch(new Request(callbackUrl, { headers: { cookie: `${PREAUTH_COOKIE}=${preAuth ?? ""}` } }));
        },
        events: async () => [forMember("member.joined", await accountHolding(idpEmail), { role: "member" })],
      });

      // Members: a role changed, the ownership handed to that member, one removed and one leaving.
      await run({
        operationId: "updateMember",
        actor: as(owner),
        status: 200,
        call: () => send(world, "PATCH", `${MEMBERS}/${member.account.id}`, cookie(owner), { role: "admin" }),
        events: () => [forMember("member.role_changed", member.account.id, { from: "member", to: "admin" })],
      });
      await run({
        operationId: "transferWorkspaceOwnership",
        actor: as(owner),
        status: 200,
        call: () => post(owner, TRANSFER, { accountId: member.account.id, demoteSelf: false }),
        events: () => [forMember("workspace.ownership_transferred", member.account.id, { demoteSelf: "false" })],
      });
      await run({
        operationId: "removeMember",
        actor: as(owner),
        status: 200,
        call: () => send(world, "DELETE", `${MEMBERS}/${removed.account.id}`, cookie(owner), { content: "delete" }),
        events: () => [forMember("member.removed", removed.account.id, { content: "delete", transferTo: owner.account.id })],
      });
      await run({
        operationId: "leaveWorkspace",
        actor: as(leaver),
        status: 200,
        call: () => post(leaver, LEAVE, { content: "transfer" }),
        events: () => [forMember("member.left", leaver.account.id, { content: "transfer", transferTo: owner.account.id })],
      });

      // Sharing: a bookmark and a folder shared with a member and the share revoked. The events name the target and what was shared, and no address, title or URL.
      const bookmarkOf = async (title: string, path: string): Promise<string> => {
        const response = await post(owner, BOOKMARKS, { url: `https://${HOST}/${path}`, title });
        expect(response.status).toBe(201);
        return idOf(response);
      };
      const single = await bookmarkOf(TITLE, "private-address");
      const noContent = (written: readonly EventRow[]): void => {
        for (const row of written) {
          for (const text of [TITLE, HOST, "private-address", member.account.email]) {
            expect(row.row, `${row.action} must not hold ${text}`).not.toContain(text);
          }
        }
      };
      const target = { targetKind: "member", targetId: member.account.id, targetName: NAME };
      let share = "";
      await run({
        operationId: "createBookmarkShare",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, `${BOOKMARKS}/${single}/shares`, { accountId: member.account.id });
          share = await idOf(response);
          return response;
        },
        events: () => [event("share.granted", { type: "bookmark", id: single }, target)],
        check: noContent,
      });
      await run({
        operationId: "deleteBookmarkShare",
        actor: as(owner),
        status: 204,
        call: () => send(world, "DELETE", `${BOOKMARKS}/${single}/shares/${share}`, cookie(owner)),
        events: () => [event("share.revoked", { type: "bookmark", id: single }, target)],
        check: noContent,
      });
      const folderResponse = await post(owner, FOLDERS, { name: "Reading" });
      expect(folderResponse.status).toBe(201);
      const folder = await idOf(folderResponse);
      await run({
        operationId: "createFolderShare",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, `${FOLDERS}/${folder}/shares`, { accountId: member.account.id });
          share = await idOf(response);
          return response;
        },
        events: () => [event("share.granted", { type: "folder", id: folder }, target)],
        check: noContent,
      });
      await run({
        operationId: "deleteFolderShare",
        actor: as(owner),
        status: 204,
        call: () => send(world, "DELETE", `${FOLDERS}/${folder}/shares/${share}`, cookie(owner)),
        events: () => [event("share.revoked", { type: "folder", id: folder }, target)],
        check: noContent,
      });

      // Bulk changes: ten bookmarks, three of them shared in one request, then all ten deleted in one request. A repeat that changes nothing records nothing.
      const ten: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        ten.push(await bookmarkOf(`${TITLE} ${String(index)}`, `private-address/${String(index)}`));
      }
      const bulk = (body: unknown) => post(owner, `${BOOKMARKS}/bulk`, body);
      await run({
        operationId: "bulkBookmarks",
        label: "bulkBookmarks share",
        actor: as(owner),
        status: 200,
        call: () => bulk({ action: "share", ids: ten.slice(0, 3), accountId: member.account.id }),
        events: [event("share.bulk_granted", null, { count: "3", ...target })],
        check: noContent,
      });
      await run({ label: "bulkBookmarks share that makes no share", operationId: "bulkBookmarks", actor: as(owner), status: 200, call: () => bulk({ action: "share", ids: ten.slice(0, 3), accountId: member.account.id }), events: [] });
      await run({ label: "bulkBookmarks delete of nothing", operationId: "bulkBookmarks", actor: as(owner), status: 200, call: () => bulk({ action: "delete", ids: ["0192f3a0-9999-7000-8000-00000000dead"] }), events: [] });
      await run({
        operationId: "bulkBookmarks",
        label: "bulkBookmarks delete of ten",
        actor: as(owner),
        status: 200,
        call: () => bulk({ action: "delete", ids: ten }),
        events: [event("bookmark.bulk_deleted", null, { count: "10" })],
        check: noContent,
      });

      // The archive services, called as the job of a composition does: one event for the bookmarks archived and one for the bookmarks restored, by the system.
      const overflow = [await bookmarkOf("Overflow one", "overflow/1"), await bookmarkOf("Overflow two", "overflow/2")];
      const asJob = <T,>(work: (tx: ReturnType<typeof bookmarkArchiveTransaction>) => Promise<T>) => () =>
        tenantDatabase(database())
          .withTenant({ accountId: owner.account.id, workspaceId, requestId: "audit-coverage" }, (tx) => work(bookmarkArchiveTransaction(tx, uuidv7)))
          .then(() => undefined);
      const request = { workspaceId, bookmarkIds: overflow };
      await run({ label: "archiveBookmarks", actor: { accountId: "system" }, call: asJob((tx) => archiveBookmarks(tx, request)), events: [event("bookmark.archived", null, { count: "2" })] });
      await run({ label: "restoreBookmarks", actor: { accountId: "system" }, call: asJob((tx) => restoreBookmarks(tx, request)), events: [event("bookmark.restored", null, { count: "2" })] });

      // The instance operator removes an ownerless bookmark with the database login, which no operation reaches: the system is the actor, labelled with the login, and the
      // event holds the bookmark's identifier and the operator's reason, never its title or address.
      const orphan = await bookmarkOf(`${TITLE} orphaned`, "private-address/orphaned");
      const operatorEventId = uuidv7();
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE bookmarks SET owner_id = NULL WHERE id = ${orphan}`;
      });
      await run({
        label: "sys_bookmark_operator_delete",
        actor: { accountId: "system", label: "slugbase_migrator" },
        call: async () => {
          const removed = await database().owner.begin(async (tx) => {
            await tx`SET LOCAL ROLE slugbase_system`;
            return tx<{ removed: boolean }[]>`SELECT sys_bookmark_operator_delete(${workspaceId}::uuid, ${orphan}::uuid, ${operatorEventId}::uuid, 'Court order, ref. 2026-123') AS removed`;
          });
          expect(removed[0]?.removed).toBe(true);
          return undefined;
        },
        events: [event("bookmark.operator_deleted", { type: "bookmark", id: orphan }, { reason: "Court order, ref. 2026-123" })],
        check: noContent,
      });

      // An export and an import: counts only, one event for an export and one for an import that writes, none for a dry run.
      await run({
        operationId: "exportJson",
        actor: as(owner),
        status: 200,
        call: async () => {
          const response = await send(world, "GET", "/api/v1/export/json", cookie(owner));
          await response.text();
          return response;
        },
        events: [event("export.created", null, { bookmarks: "3", folders: "1", tags: "0", shared: "0" })],
        check: noContent,
      });
      const file = [{ url: `https://${HOST}/imported/1` }, { url: `https://${HOST}/imported/2` }];
      await run({ label: "importJson dry run", operationId: "importJson", actor: as(owner), status: 200, call: () => post(owner, "/api/v1/import/json?dryRun=true", file), events: [] });
      await run({
        operationId: "importJson",
        actor: as(owner),
        status: 200,
        call: () => post(owner, "/api/v1/import/json", file),
        events: [event("import.completed", null, { created: "2", skipped: "0", failed: "0", slugsDropped: "0", foldersCreated: "0", tagsCreated: "0" })],
      });

      // An instance admin adds themselves: the workspace's log holds its own action and the instance stream the admin's.
      await run({
        operationId: "addInstanceAdminMembership",
        actor: { accountId: root.accountId },
        status: 201,
        call: () => send(world, "POST", `/api/v1/instance/workspaces/${workspaceId}/membership`, { cookie: root.cookie }),
        events: [
          forMember("member.instance_admin_joined", root.accountId, { role: "member" }),
          { action: "instance.workspace_joined", workspaceId: null, entity: { type: "workspace", id: workspaceId }, metadata: {} },
        ],
      });

      // A second workspace, created and then deleted by its owner.
      let second = "";
      await run({
        operationId: "createWorkspace",
        actor: as(creator),
        status: 201,
        call: async () => {
          const response = await post(creator, WORKSPACES, { name: "Second workspace" });
          second = await idOf(response);
          return response;
        },
        events: () => [inWorkspace(second, "workspace.created", { type: "workspace", id: second }, { name: "Second workspace" })],
      });
      await run({ operationId: "setActiveWorkspace", actor: as(creator), status: 204, call: () => send(world, "PUT", ACTIVE_WORKSPACE, cookie(creator), { workspaceId: second }), events: [] });
      await run({
        operationId: "deleteWorkspace",
        actor: as(creator),
        status: 202,
        call: () => send(world, "DELETE", WORKSPACE, cookie(creator)),
        events: () => [inWorkspace(second, "workspace.deletion_requested", { type: "workspace", id: second }, {})],
      });

      // What is not a workspace's audit event: a sign-in, an API token created and one revoked leave no event in any log.
      await run({
        operationId: "login",
        actor: as(owner),
        status: 200,
        call: () => send(world, "POST", "/api/v1/auth/login", {}, { email: owner.account.email, password: owner.account.password, remember: false }),
        events: [],
      });
      let token = "";
      await run({
        operationId: "createApiToken",
        actor: as(owner),
        status: 201,
        call: async () => {
          const response = await post(owner, TOKENS, { name: "Coverage", scope: "read" });
          token = await idOf(response);
          return response;
        },
        events: [],
      });
      await run({ operationId: "revokeApiToken", actor: as(owner), status: 204, call: () => send(world, "DELETE", `${TOKENS}/${token}`, cookie(owner)), events: [] });

      // The script covers the catalog: every action is written by a step, no workspace holds an action outside it, and every operation the script names exists.
      expect(
        AUDIT_ACTION_NAMES.filter((action) => !seen.has(action)),
        "catalog actions no step of the script writes",
      ).toEqual([]);
      expect(outsideCatalog, "events of a workspace whose action the catalog does not hold").toEqual([]);
      expect(
        [...new Set(ran)].filter((operationId) => !operations.has(operationId)),
        "operations of the script that openapi.json does not hold",
      ).toEqual([]);

      // The log as the owner reads it: GET /audit-events holds every event of the workspace the script wrote, newest first, with the category of its action.
      const stored = (await allEvents()).filter((row) => row.workspace_id === workspaceId);
      const listed: { id: string; action: string; category: string; actor: { label: string }; metadata: Record<string, string> }[] = [];
      for (let cursor: string | null = null, pages = 0; pages < 10; pages += 1) {
        const response = await send(world, "GET", `${AUDIT}?limit=100${cursor === null ? "" : `&cursor=${cursor}`}`, cookie(owner));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: typeof listed; nextCursor: string | null };
        listed.push(...body.items);
        cursor = body.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      ran.push("listAuditEvents");
      expect(operations.has("listAuditEvents")).toBe(true);
      expect(listed.map((item) => item.id)).toEqual(stored.map((row) => row.id).reverse());
      for (const [index, item] of listed.entries()) {
        const row = stored[stored.length - 1 - index];
        expect([item.action, item.category, item.actor.label, item.metadata]).toEqual([row?.action, row?.action.split(".")[0], row?.actor_label, row?.metadata]);
      }
      expect([...new Set(listed.map((item) => item.action))].sort(), "the actions of the workspace the owner reads").toEqual(
        AUDIT_ACTION_NAMES.filter((action) => action !== "workspace.created" && action !== "workspace.deletion_requested").sort(),
      );
    },
    HOOK_TIMEOUT_MS,
  );
});
