import {
  addInstanceAdminMembership as addInstanceAdminMembershipOperation,
  createInstanceWorkspace as createInstanceWorkspaceOperation,
  deleteInstanceAccount as deleteInstanceAccountOperation,
  deleteInstanceWorkspace as deleteInstanceWorkspaceOperation,
  getInstanceSettings,
  getInstanceStatus,
  issueInstanceAccountResetLink as issueInstanceAccountResetLinkOperation,
  listInstanceAccounts as listInstanceAccountsOperation,
  listInstanceWorkspaces as listInstanceWorkspacesOperation,
  resendInstanceAccountVerification as resendInstanceAccountVerificationOperation,
  resetInstanceAccountMfa as resetInstanceAccountMfaOperation,
  sendInstanceTestMail,
  updateInstanceAccount as updateInstanceAccountOperation,
  updateInstanceSettings,
} from "@slugbase/contracts";
import {
  addInstanceAdminMembership,
  createInstanceWorkspace,
  deleteInstanceAccount,
  InstanceAdminRequiredError,
  invitationLink,
  issueInstanceResetLink,
  listInstanceAccounts,
  listInstanceWorkspaces,
  requestInstanceAccountVerification,
  requestInstanceWorkspaceDeletion,
  resetInstanceAccountMfa,
  updateInstanceAccount,
  type Adapters,
  type InstanceAccount,
  type InstanceAccountDeletionStore,
  type InstanceAccountStore,
  type InstanceRecoveryStore,
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
// POST /api/v1/instance/workspaces/{id}/membership (doc 02 section 11.1, doc 05 section 3.3, doc 10 T15) adds the calling admin to a
// workspace as a member, the explicit way into one that the list never gives. It needs a session that re-authenticated within ten
// minutes (stage 9 judges that before the handler runs). One `sys_instance_add_membership` call makes the membership and writes
// `member.instance_admin_joined` into the workspace's own audit log and `instance.workspace_joined` into the instance stream; `member.joined` is
// queued in the same transaction, so each exists exactly when the others do. The admin is added and nobody else, whichever admin
// asks: the account is the one of the session. 409 `already_member` for an account that holds any role in the workspace, and 404
// for a workspace that does not exist or is being deleted, with nothing written in either case. The session is not moved to the workspace.
//
// GET /api/v1/instance/accounts and PATCH /api/v1/instance/accounts/{id} (doc 02 section 11.2, doc 04 section 10.10, doc 05
// sections 3.3 and 7.1) list the accounts and change the instance-admin flag and the disabled state of one. Each goes through a
// `sys_instance_*` function that repeats the admin check in the database and writes its instance audit event in the same call.
// The list is the fields of an account the admin needs to find it and tell its state and nothing secret. The change needs a session
// that re-authenticated within ten minutes (stage 9 judges that before the handler runs). Granting the flag is first put to the
// composition's `instanceAdminGrant` check, which can refuse it (Q44): a refusal is 403 with nothing written. The flag and the
// disabled state are applied by one database call that checks the admin once, in a transaction that is rolled back on any refusal:
// `last_instance_admin` (422 `validation_failed` with that field code on the field refused) when the change would leave no enabled instance admin, decided by the database under
// the advisory lock of the set of admins, and 404 for an account that does not exist. Changing the flag, or disabling, deletes the
// target's sessions, so the next request of each answers 401; a disabled account's API tokens are refused by their lookup. When the
// account is disabled and mail is configured the email that tells it so is queued in the same transaction.
//
// POST /api/v1/instance/accounts/{id}/mfa-reset, /password-reset-link and /verification-email (doc 02 sections 2.7 and 11.2, doc 04 section
// 10.10, doc 10 T7 and T17) recover an account, and PATCH /api/v1/instance/accounts/{id} marks its address verified with `emailVerified: true`.
// Each goes through a `sys_instance_*` function that repeats the admin check in the database and writes its instance audit event in the same
// call. The reset of the second factor and the reset link need a session that re-authenticated within ten minutes. The reset clears the factor
// and deletes the target's sessions in the database and never reads the secret; the email that tells the account is queued in the same
// transaction where mail is configured. The reset link is a one-hour password-reset token: where mail is configured it is mailed (the mail job
// makes the token, as for a member's own request) and the response carries none, and where it is not the application makes it, the database
// stores its hash and the response returns the link once. The verification email is queued in the transaction that audits it and needs mail
// (503 `mail_unavailable` before anything is written otherwise). A disabled account is refused by all three, a refusal is 422 `validation_failed`
// with a field code on `id` (`account_disabled`, `self`, `email_unverified`, `no_password`, `already_verified`), and 404 is an account that
// does not exist; a reset of an account without a confirmed second factor changes nothing and answers 204 all the same.
//
// Every route here answers 403 `forbidden`, with nothing written, when the database's own admin check refuses a caller whom the policy admitted: another
// admin demoted, disabled or deleted the account in between (doc 05 section 7.1).
//
// DELETE /api/v1/instance/accounts/{id} (doc 02 sections 2.10 and 11.2, doc 04 section 10.10, doc 05 sections 3.3 and 7.1, doc 01 section
// 13.2, doc 10 T1 and T18) deletes another account with the rules of `DELETE /me`, ownership resolved first. It needs a session that
// re-authenticated within ten minutes. One transaction reads the account's scope under the locks of `sys_instance_account_deletion_scope`
// (the account's workspaces, its backup codes, the rows of the admin and of the account and, for an admin, the advisory key of the set of
// admins), refuses with 409 `last_owner` while the account is the only owner of a workspace that has other members, naming each such
// workspace, and with 422 `validation_failed` and the field code `last_instance_admin` (on `id`) when it is the only enabled instance
// admin, asks the deletion guard with `requestedBy: instanceAdmin` for the account and for every workspace that goes with it (a refusal is
// its code, 409 `billing_active`; a guard that throws or times out is 503 from the dispatcher), and then deletes the account, marks the
// workspaces where it was the only member, writes `instance.account_deleted` and queues the `workspace.delete` jobs and `account.deleted`,
// all in that transaction (`sys_instance_delete_account`). The admin's own account is refused with the field code `self`: `DELETE /me`
// asks for the typed address and ends the session, and this route does neither. 404 is an account that does not exist.
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
  /** Whether the flag may be granted; the composition's choice (Q44). Defaults to granting. */
  readonly instanceAdminGrant?: InstanceAdminGrantCheck;
}

/** The composition's decision on granting the instance-admin flag (Q44): it may refuse, and by default it does not. */
export type InstanceAdminGrantCheck = (subject: { readonly accountId: string; readonly targetAccountId: string }) => boolean | Promise<boolean>;

/** The Community Edition grants the flag to whoever an instance admin names. */
export const allowInstanceAdminGrant: InstanceAdminGrantCheck = () => true;

const ADMIN_GRANT_REFUSED = "This deployment does not grant the instance-admin flag.";
const NO_SUCH_ACCOUNT_TO_CHANGE = "There is no such account.";
const LAST_INSTANCE_ADMIN = "The instance must keep an enabled instance admin.";
const MAIL_UNAVAILABLE = "Email delivery is not available on this instance.";
const ACCOUNT_DISABLED = "The account is disabled; enable it first.";
const OWN_MFA = "Your own two-factor authentication is turned off in your account settings, with your second factor.";
const EMAIL_UNVERIFIED = "The account's address is not verified; mark it verified or resend the verification email first.";
const NO_PASSWORD = "The account has no password to reset; it signs in through a provider.";
const ALREADY_VERIFIED = "The account's address is verified already.";
const NO_SUCH_ACCOUNT = "There is no account that can own the workspace.";
const NO_SUCH_WORKSPACE = "There is no such workspace.";
const ALREADY_MEMBER = "You are a member of this workspace already.";
const DELETION_REFUSED = "The workspace cannot be deleted while its subscription is active; cancel the subscription first.";
const ACCOUNT_DELETION_REFUSED = "The account cannot be deleted while a subscription is active; cancel the subscription first.";
const OWN_ACCOUNT = "Your own account is deleted in your account settings.";
const LAST_OWNER = "The account is the only owner of workspaces that have other members; transfer their ownership or delete them first.";
const ACCOUNT_DELETION_UNAVAILABLE = "The account could not be deleted; try again.";

function accountBody({ id, displayName, email, emailVerified, mfaEnabled, isInstanceAdmin, disabled, lastSignInAt, workspaceCount }: InstanceAccount) {
  return { id, displayName, email, emailVerified, mfaEnabled, isInstanceAdmin, disabled, lastSignInAt: lastSignInAt === null ? null : lastSignInAt.toISOString(), workspaceCount };
}

const FORBIDDEN = "You do not have access to this resource.";

function sessionOf(context: ChainContext): { readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("forbidden", FORBIDDEN);
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
    addMembership: (request, ipPrefix) =>
      repository.addMembership(
        request,
        ipPrefix,
        request.events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
      ),
  };
}

/** The account operations of the instance admin, bound to the account-level transaction of the request. */
function accountStoreOf(tx: TenantTx): InstanceAccountStore {
  const repository = instanceRepository(tx);
  return {
    listAccounts: (eventId, ipPrefix) => repository.listAccounts(eventId, ipPrefix),
    updateAccount: (accountId, change, notify, eventIds, ipPrefix) =>
      repository.updateAccount(accountId, change, eventIds, ipPrefix, change.disabled === true && notify ? [queueMailSend(uuidv7(), "accountDisabled", accountId)] : []),
  };
}

/** The account deletion of the instance admin, bound to the account-level transaction of the request; the deletion queues its jobs and events in that transaction. */
function accountDeletionStoreOf(tx: TenantTx): InstanceAccountDeletionStore {
  const repository = instanceRepository(tx);
  return {
    scope: (accountId) => repository.accountDeletionScope(accountId),
    delete: ({ accountId, soleWorkspaceIds, eventId, ipPrefix, events }) =>
      repository.deleteAccount({ accountId, soleWorkspaceIds, eventId, ipPrefix }, [
        ...soleWorkspaceIds.map((workspaceId) => ({ id: uuidv7(), queue: WORKSPACE_DELETE_JOB, data: { workspaceId } })),
        ...events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
      ]),
  };
}

/** The recovery operations of the instance admin, bound to the account-level transaction of the request; each queues its email in that transaction. */
function recoveryStoreOf(tx: TenantTx): InstanceRecoveryStore {
  const repository = instanceRepository(tx);
  return {
    resetMfa: (accountId, eventId, notify, ipPrefix) =>
      repository.resetMfa(accountId, eventId, ipPrefix, notify ? [queueMailSend(uuidv7(), "mfaReset", accountId)] : []),
    // Without a token the link travels by mail, which the mail job makes when it runs.
    issueResetLink: (accountId, eventId, token, ipPrefix) =>
      repository.issueResetLink(accountId, eventId, token, ipPrefix, token === undefined ? [queueMailSend(uuidv7(), "passwordReset", accountId)] : []),
    requestVerification: (accountId, eventId, ipPrefix) => repository.requestVerification(accountId, eventId, ipPrefix, [queueMailSend(uuidv7(), "verifyEmail", accountId)]),
  };
}

/** A refusal of a recovery operation that names the account: the field is the `id` of the path. */
function refusal(message: string, code: string): ProblemError {
  return new ProblemError("validation_failed", message, { errors: [{ path: "id", code }] });
}

export function instanceRoutes({
  withTenant: tenantTransaction,
  databaseUrl,
  chains,
  buildInfo,
  adapters,
  registration,
  appOrigin,
  instanceAdminGrant = allowInstanceAdminGrant,
}: InstanceRoutesOptions): RouteBinding[] {
  // The policy admitted the caller before the handler ran; an admin whose standing another admin's commit took away in between is
  // refused by the database's own check, and answers like a caller the policy excludes.
  const withTenant: Database["withTenant"] = (context, fn) =>
    tenantTransaction(context, fn).catch((error: unknown) => {
      throw error instanceof InstanceAdminRequiredError ? new ProblemError("forbidden", FORBIDDEN) : error;
    });
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

    route(addInstanceAdminMembershipOperation).handle(async ({ params }, context) => {
      const { accountId } = sessionOf(context);
      const workspaceId = params.id.toLowerCase();
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        addInstanceAdminMembership({ store: workspaceStoreOf(tx), newId: uuidv7 }, { workspaceId, accountId, ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null }),
      );
      switch (outcome.kind) {
        case "added":
          return { status: 201, body: { workspaceId, role: "member" } };
        case "already_member":
          throw new ProblemError("already_member", ALREADY_MEMBER);
        case "unknown_workspace":
          throw new ProblemError("not_found", NO_SUCH_WORKSPACE);
      }
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

    route(listInstanceAccountsOperation).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      const accounts = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        listInstanceAccounts({ store: accountStoreOf(tx), newId: uuidv7 }, { ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null }),
      );
      return { status: 200, body: { items: accounts.map(accountBody) } };
    }),

    route(updateInstanceAccountOperation).handle(async ({ params, body }, context) => {
      const { accountId } = sessionOf(context);
      const targetAccountId = params.id.toLowerCase();
      if (body.isInstanceAdmin === true && !(await instanceAdminGrant({ accountId, targetAccountId }))) {
        throw new ProblemError("forbidden", ADMIN_GRANT_REFUSED);
      }
      const account = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const outcome = await updateInstanceAccount(
          { store: accountStoreOf(tx), newId: uuidv7 },
          {
            accountId: targetAccountId,
            ...(body.isInstanceAdmin === undefined ? {} : { isInstanceAdmin: body.isInstanceAdmin }),
            ...(body.disabled === undefined ? {} : { disabled: body.disabled }),
            ...(body.emailVerified === undefined ? {} : { emailVerified: body.emailVerified }),
            notify: adapters.mail.available,
            ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
          },
        );
        // A refusal throws inside the transaction, which rolls back whatever the call wrote.
        switch (outcome.kind) {
          case "updated":
            return outcome.account;
          case "unknown_account":
            throw new ProblemError("not_found", NO_SUCH_ACCOUNT_TO_CHANGE);
          case "last_instance_admin":
            throw new ProblemError("validation_failed", LAST_INSTANCE_ADMIN, { errors: [{ path: outcome.field, code: "last_instance_admin" }] });
        }
      });
      return { status: 200, body: accountBody(account) };
    }),

    route(deleteInstanceAccountOperation).handle(async ({ params }, context) => {
      const { accountId } = sessionOf(context);
      const hooks = context.get("hooks");
      if (hooks === undefined) {
        throw new Error("the instance account deletion route was reached without the hook dispatcher");
      }
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        deleteInstanceAccount(
          {
            store: accountDeletionStoreOf(tx),
            guard: (input) =>
              hooks.deletionGuard(
                input.kind === "account"
                  ? { kind: "account", accountId: input.accountId, requestedBy: "instanceAdmin" }
                  : { kind: "workspace", workspaceId: input.workspaceId, accountId: input.accountId, requestedBy: "instanceAdmin" },
              ),
            newId: uuidv7,
          },
          { accountId: params.id.toLowerCase(), ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null },
        ),
      );
      switch (outcome.kind) {
        case "deleted":
          return { status: 204 };
        case "unknown_account":
          throw new ProblemError("not_found", NO_SUCH_ACCOUNT_TO_CHANGE);
        case "last_instance_admin":
          throw refusal(LAST_INSTANCE_ADMIN, "last_instance_admin");
        case "self":
          throw refusal(OWN_ACCOUNT, "self");
        case "last_owner":
          throw new ProblemError("last_owner", LAST_OWNER, { members: { workspaces: outcome.workspaces.map(({ id, name }) => ({ id, name })) } });
        case "refused":
          throw new ProblemError(outcome.code, ACCOUNT_DELETION_REFUSED);
        case "unavailable":
          throw new ProblemError("unavailable", ACCOUNT_DELETION_UNAVAILABLE);
      }
    }),

    route(resetInstanceAccountMfaOperation).handle(async ({ params }, context) => {
      const { accountId } = sessionOf(context);
      await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const outcome = await resetInstanceAccountMfa(
          { store: recoveryStoreOf(tx), newId: uuidv7 },
          { accountId: params.id.toLowerCase(), notify: adapters.mail.available, ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null },
        );
        switch (outcome) {
          case "reset":
          case "mfa_not_enabled":
            return;
          case "unknown_account":
            throw new ProblemError("not_found", NO_SUCH_ACCOUNT_TO_CHANGE);
          case "account_disabled":
            throw refusal(ACCOUNT_DISABLED, "account_disabled");
          case "self":
            throw refusal(OWN_MFA, "self");
        }
      });
      return { status: 204 };
    }),

    route(issueInstanceAccountResetLinkOperation).handle(async ({ params }, context) => {
      const { accountId } = sessionOf(context);
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const result = await issueInstanceResetLink(
          { store: recoveryStoreOf(tx), newId: uuidv7 },
          { accountId: params.id.toLowerCase(), mailAvailable: adapters.mail.available, origin: appOrigin, ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null },
        );
        switch (result.kind) {
          case "mailed":
          case "link":
            return result;
          case "unknown_account":
            throw new ProblemError("not_found", NO_SUCH_ACCOUNT_TO_CHANGE);
          case "account_disabled":
            throw refusal(ACCOUNT_DISABLED, "account_disabled");
          case "email_unverified":
            throw refusal(EMAIL_UNVERIFIED, "email_unverified");
          case "no_password":
            throw refusal(NO_PASSWORD, "no_password");
        }
      });
      return { status: 200, body: outcome.kind === "link" ? { delivery: "link", link: outcome.link } : { delivery: "mail", link: null } };
    }),

    route(resendInstanceAccountVerificationOperation).handle(async ({ params }, context) => {
      const { accountId } = sessionOf(context);
      if (!adapters.mail.available) {
        throw new ProblemError("mail_unavailable", MAIL_UNAVAILABLE);
      }
      await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const outcome = await requestInstanceAccountVerification(
          { store: recoveryStoreOf(tx), newId: uuidv7 },
          { accountId: params.id.toLowerCase(), ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null },
        );
        switch (outcome) {
          case "requested":
            return;
          case "unknown_account":
            throw new ProblemError("not_found", NO_SUCH_ACCOUNT_TO_CHANGE);
          case "account_disabled":
            throw refusal(ACCOUNT_DISABLED, "account_disabled");
          case "already_verified":
            throw refusal(ALREADY_VERIFIED, "already_verified");
        }
      });
      return { status: 202 };
    }),
  ];
}
