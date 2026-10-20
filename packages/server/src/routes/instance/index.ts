import {
  createInstanceWorkspace as createInstanceWorkspaceOperation,
  deleteInstanceWorkspace as deleteInstanceWorkspaceOperation,
  getInstanceSettings,
  getInstanceStatus,
  listInstanceWorkspaces as listInstanceWorkspacesOperation,
  sendInstanceTestMail,
  updateInstanceSettings,
} from "@slugbase/contracts";
import {
  createInstanceWorkspace,
  invitationLink,
  listInstanceWorkspaces,
  requestInstanceWorkspaceDeletion,
  type Adapters,
  type InstanceWorkspaceStore,
  type RegistrationSettings,
} from "@slugbase/core";
import { instanceRepository, migrationLevel, type Database, type MigrationChain, type TenantTx } from "@slugbase/db";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { BuildInfo } from "../../build-info.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { WORKSPACE_DELETE_JOB } from "../../worker/jobs/workspace-delete.ts";
import { route } from "../register.ts";

// The operations of the CE instance admin (doc 04 section 10.10, doc 02 section 11, doc 10 T3 and T15). Every one
// declares the `instanceAdmin` policy, which stage 9 enforces before a handler runs: a complete session of an account
// that holds the flag and has a second factor enrolled, and no API token. The operations are mounted on every
// deployment, a composition that has no admin answers every call 403, and the system operations they call check the
// account again inside the database.
//
// GET /api/v1/instance/status reports what the operator configured and what the instance holds: the build's version
// and the migration level, which optional ports are configured, the OIDC providers that answered discovery (slug
// and name), the registration settings in force, the counts, and the health of the background jobs. Nothing of it is
// a credential: a port is a boolean, a provider has no URL or secret, and the database URL is read, never returned.
// Reading the status is an action of the admin and is written to the instance audit stream in the same transaction
// that reads the counts.
//
// GET and PATCH /api/v1/instance/settings read and change the instance settings (doc 02 section 11.3). Both go
// through a `sys_instance_*` function that repeats the admin check in the database and writes the instance audit
// event in the same call: `instance.settings_viewed` for the read and `instance.settings_changed` for the change; a setting the body leaves out keeps its value and null
// clears one. The workspace routes read the stored `allowWorkspaceCreation` on every request, so a change applies
// on the next one.
//
// GET, POST and DELETE /api/v1/instance/workspaces (doc 02 section 11.1, doc 05 section 3.3) list every workspace, create one
// and delete one. Each goes through a `sys_instance_*_workspace` function that repeats the admin check in the database and writes
// its instance audit event in the same call. The list is the workspace's name, owners, member count and creation time and nothing
// the workspace holds; the admin acts in no workspace they are not a member of, and the list gives no way into one. A creation
// names an owner account, which becomes the owner, or an owner address: the workspace then has no member and one pending owner
// invitation (the only owner invitation there is; the public invitation operation still refuses `owner`), and the link of that
// invitation is returned once, in the response, since no workspace admin exists yet to hand it out and the invitation mail job
// carries no owner role. `workspace.created` is announced for an account that becomes the owner. A deletion needs a session that
// re-authenticated within ten minutes (the authorization stage judges it before the handler runs); the deletion guard of the
// composition is asked first, with `requestedBy: instanceAdmin`, and a refusal is its code (409 billing_active) with nothing
// written, a guard that throws or times out is 503 from the dispatcher. The mark, the revocation of the workspace's tokens, the
// sessions pointed at none, the `workspace.delete` job of `DELETE /api/v1/workspace` and the audit event are one transaction.
//
// POST /api/v1/instance/mail/test queues a test message to the calling admin's address, as the `mail.send` job reads
// the address when it runs, and writes `instance.test_mail_queued` in the transaction that queues it. A deployment
// without a mail adapter answers `503 mail_unavailable` before anything is written.

export interface InstanceRoutesOptions {
  readonly withTenant: Database["withTenant"];
  /** `DATABASE_URL`: the migration level is read as `slugbase_app`, which `migrate` lets read the bookkeeping tables. */
  readonly databaseUrl: string;
  /** The migration sets this build ships after the CE chain, read when the request is served, once the composition is complete. */
  readonly chains: () => readonly MigrationChain[];
  readonly buildInfo: BuildInfo;
  /** What the status reports as configured; only whether a port is available, and the providers' slug and name, are read. */
  readonly adapters: Pick<Adapters, "mail" | "ai" | "identity" | "errors">;
  /** The settings in force for public registration and email verification. */
  readonly registration: RegistrationSettings;
  /** `APP_ORIGIN`: the link of an owner invitation points to it. */
  readonly appOrigin: string;
}

const MAIL_UNAVAILABLE = "Email delivery is not available on this instance.";
const NO_SUCH_ACCOUNT = "There is no account that can own the workspace.";
const NO_SUCH_WORKSPACE = "There is no such workspace.";
const DELETION_REFUSED = "The workspace cannot be deleted while its subscription is active; cancel the subscription first.";

function sessionOf(context: ChainContext): { readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("forbidden", "You do not have access to this resource.");
  }
  return principal;
}

/** The workspace operations of the instance admin, bound to the account-level transaction of the request. */
function workspaceStoreOf(tx: TenantTx): InstanceWorkspaceStore {
  const repository = instanceRepository(tx);
  return {
    listWorkspaces: (eventId, ipPrefix) => repository.listWorkspaces(eventId, ipPrefix),
    createWorkspace: (request, eventId, ipPrefix) =>
      repository.createWorkspace(
        request,
        eventId,
        ipPrefix,
        request.events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
      ),
    markWorkspaceDeleting: (workspaceId, eventId, ipPrefix) =>
      repository.markWorkspaceDeleting(workspaceId, eventId, ipPrefix, [{ id: uuidv7(), queue: WORKSPACE_DELETE_JOB, data: { workspaceId } }]),
  };
}

export function instanceRoutes({ withTenant, databaseUrl, chains, buildInfo, adapters, registration, appOrigin }: InstanceRoutesOptions): RouteBinding[] {
  return [
    route(getInstanceStatus).handle(async (_request, context) => {
      const principal = sessionOf(context);
      const level = await migrationLevel({ url: databaseUrl, chains: chains() });
      const providers = adapters.identity.available ? await adapters.identity.listProviders() : [];
      const { counts, jobs } = await withTenant({ accountId: principal.accountId, requestId: requestIdOf(context) }, async (tx) => {
        const repository = instanceRepository(tx);
        return {
          counts: await repository.status(uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null),
          jobs: await repository.jobHealth(),
        };
      });
      return {
        status: 200,
        body: {
          version: buildInfo.version,
          migrations: { expected: level.expected, applied: level.applied },
          ports: { mail: adapters.mail.available, ai: adapters.ai.available, errorReporting: adapters.errors.available },
          oidcProviders: providers.map(({ id, displayName }) => ({ slug: id, name: displayName })),
          signIn: { publicRegistration: registration.publicRegistration, emailVerificationRequired: registration.emailVerificationRequired },
          counts,
          jobs: { queueDepth: jobs.queueDepth, failed: jobs.failed },
        },
      };
    }),

    route(getInstanceSettings).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      const settings = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        instanceRepository(tx).viewSettings(uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null),
      );
      return { status: 200, body: settings };
    }),

    route(updateInstanceSettings).handle(async ({ body }, context) => {
      const { accountId } = sessionOf(context);
      const settings = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        instanceRepository(tx).updateSettings(body, uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null),
      );
      return { status: 200, body: settings };
    }),

    route(sendInstanceTestMail).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      if (!adapters.mail.available) {
        throw new ProblemError("mail_unavailable", MAIL_UNAVAILABLE);
      }
      await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        instanceRepository(tx).recordTestMail(uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null, queueMailSend(uuidv7(), "testMail", accountId)),
      );
      return { status: 202 };
    }),

    route(listInstanceWorkspacesOperation).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      const workspaces = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        listInstanceWorkspaces({ store: workspaceStoreOf(tx), newId: uuidv7 }, { ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null }),
      );
      return {
        status: 200,
        body: {
          items: workspaces.map(({ id, name, owners, memberCount, createdAt }) => ({
            id,
            name,
            owners: owners.map(({ accountId: ownerId, displayName, email }) => ({ accountId: ownerId, displayName, email })),
            memberCount,
            createdAt: createdAt.toISOString(),
          })),
        },
      };
    }),

    route(createInstanceWorkspaceOperation).handle(async ({ body }, context) => {
      const { accountId } = sessionOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        createInstanceWorkspace(
          { store: workspaceStoreOf(tx), newId: uuidv7 },
          {
            name: body.name,
            ...(body.ownerAccountId === undefined ? {} : { ownerAccountId: body.ownerAccountId.toLowerCase() }),
            ...(body.ownerEmail === undefined ? {} : { ownerEmail: body.ownerEmail }),
            ipPrefix,
          },
        ),
      );
      if (outcome.kind === "unknown_account") {
        throw new ProblemError("validation_failed", NO_SUCH_ACCOUNT, { errors: [{ path: "ownerAccountId", code: "unknown_account" }] });
      }
      const { invitation } = outcome;
      return {
        status: 201,
        body: {
          id: outcome.workspaceId,
          name: body.name,
          ownerInvitation:
            invitation === undefined
              ? null
              : { id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt.toISOString(), link: invitationLink(appOrigin, invitation.token) },
        },
      };
    }),

    route(deleteInstanceWorkspaceOperation).handle(async ({ params }, context) => {
      const { accountId } = sessionOf(context);
      const hooks = context.get("hooks");
      if (hooks === undefined) {
        throw new Error("the instance workspace deletion route was reached without the hook dispatcher");
      }
      const workspaceId = params.id.toLowerCase();
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        requestInstanceWorkspaceDeletion(
          {
            store: workspaceStoreOf(tx),
            newId: uuidv7,
            guard: (input) => hooks.deletionGuard({ kind: "workspace", workspaceId: input.workspaceId, accountId, requestedBy: "instanceAdmin" }),
          },
          { workspaceId, ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null },
        ),
      );
      switch (outcome.kind) {
        case "requested":
          return { status: 202 };
        case "refused":
          throw new ProblemError(outcome.code, DELETION_REFUSED);
        case "unavailable":
          throw new ProblemError("not_found", NO_SUCH_WORKSPACE);
      }
    }),
  ];
}
