import { deleteMe } from "@slugbase/contracts";
import { deleteAccount, type AccountDeletionStore, type SessionCookieSpec } from "@slugbase/core";
import { accountDeletionRepository, accountProfileRepository, type Database } from "@slugbase/db";
import { clearSessionCookie } from "../../auth/cookie.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { WORKSPACE_DELETE_JOB } from "../../worker/jobs/workspace-delete.ts";
import { route } from "../register.ts";

// DELETE /api/v1/me (doc 04 section 10.3, doc 02 section 2.10, doc 05 section 7.1, doc 01 section 13.2, doc 10 T1 and T18)
// deletes the account the session belongs to. It is an account operation that needs a session which re-authenticated
// within ten minutes (the authorization stage judges that before the handler runs, and an API token never reaches it),
// and the body is the account's own address, typed. The service judges the typed address, then refuses with 422
// `validation_failed` and the field code `last_instance_admin` when the account is the only instance admin (the
// database decides that under a lock that serialises the admins' deletions), then refuses with 409
// `last_owner` while the account is the only owner of a workspace that has other members, naming each such
// workspace, and then asks the deletion guard of the composition for the account and for every workspace that goes
// with it: a refusal is its code (409 `billing_active`), and a guard that throws or times out is 503 from the
// dispatcher, both with nothing written. The deletion of the account, the marking of the workspaces where it is the
// only member, their `workspace.delete` jobs and the `account.deleted` event are one transaction (`sys_delete_account`).
// The session the request was made with goes with the account, so the answer clears its cookie.

const UNAUTHENTICATED = "Authentication is required.";
const EMAIL_MISMATCH = "The address typed is not the address of the account.";
const LAST_INSTANCE_ADMIN = "The account is the only instance admin; make another account an instance admin first.";
const LAST_OWNER = "The account is the only owner of workspaces that have other members; transfer their ownership or delete them first.";
const DELETION_REFUSED = "The account cannot be deleted while a subscription is active; cancel the subscription first.";
const UNAVAILABLE = "The account could not be deleted; try again.";

export interface AccountDeletionRoutesOptions {
  readonly withTenant: Database["withTenant"];
  readonly cookie: SessionCookieSpec;
}

export function accountDeletionRoutes({ withTenant, cookie }: AccountDeletionRoutesOptions): RouteBinding[] {
  return [
    route(deleteMe).handle(async ({ body }, context) => {
      const principal = context.get("principal");
      if (principal?.kind !== "session") {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      const hooks = context.get("hooks");
      if (hooks === undefined) {
        throw new Error("the account deletion route was reached without the hook dispatcher");
      }
      const { accountId } = principal;
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        const repository = accountDeletionRepository(tx);
        const store: AccountDeletionStore = {
          scope: () => repository.scope(),
          delete: ({ soleWorkspaceIds, events }) =>
            repository.delete(soleWorkspaceIds, [
              ...soleWorkspaceIds.map((workspaceId) => ({ id: uuidv7(), queue: WORKSPACE_DELETE_JOB, data: { workspaceId } })),
              ...events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
            ]),
        };
        return deleteAccount(
          {
            store,
            guard: (input) =>
              hooks.deletionGuard(
                input.kind === "account"
                  ? { kind: "account", accountId: input.accountId, requestedBy: "member" }
                  : { kind: "workspace", workspaceId: input.workspaceId, accountId: input.accountId, requestedBy: "member" },
              ),
            newId: uuidv7,
          },
          { accountId, accountEmail: profile.email, typedEmail: body.email },
        );
      });
      switch (outcome.kind) {
        case "deleted":
          return { status: 204, headers: { "Set-Cookie": clearSessionCookie(cookie) } };
        case "email_mismatch":
          throw new ProblemError("validation_failed", EMAIL_MISMATCH, { errors: [{ path: "email", code: "email_mismatch" }] });
        case "last_instance_admin":
          throw new ProblemError("validation_failed", LAST_INSTANCE_ADMIN, { errors: [{ path: "email", code: "last_instance_admin" }] });
        case "last_owner":
          throw new ProblemError("last_owner", LAST_OWNER, { members: { workspaces: outcome.workspaces.map(({ id, name }) => ({ id, name })) } });
        case "refused":
          throw new ProblemError(outcome.code, DELETION_REFUSED);
        case "unavailable":
          throw new ProblemError("unavailable", UNAVAILABLE);
      }
    }),
  ];
}
