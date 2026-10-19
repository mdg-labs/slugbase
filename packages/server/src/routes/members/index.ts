import { listMembers, removeMember, updateMember, type MemberSchema } from "@slugbase/contracts";
import { changeMemberRole, createAuditWriter, type AuditActor, type SessionCookieSpec } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, isLastOwnerViolation, memberRepository, type WorkspaceMember } from "@slugbase/db";
import { z } from "zod";
import { setSessionCookie } from "../../auth/cookie.ts";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { newSessionToken } from "../../auth/session-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";
import { endMembershipOf } from "./departure.ts";

// GET /api/v1/members, PATCH /api/v1/members/{accountId} and DELETE /api/v1/members/{accountId} (doc 04 section 10.5, doc 02 section 3.3, doc 10
// T1, T2 and T3). Both act in the workspace the request is bound to, which the tenant stage resolved from the
// session or the token, and name a member by account identifier only: an account outside that workspace is
// answered like one that does not exist (404), whatever workspace it belongs to. The list is open to a member
// and a read-scope token and shows the co-member projection of each account (display name and email) and
// nothing else of it. The role change is an admin's and declares no token scope, so a token never reaches it.
// Which role changes the caller may make is judged by the member service under the lock of the workspace; that
// the workspace keeps an owner is the database's rule, a deferred constraint trigger that refuses the commit of
// a transaction that would leave none, which is answered 409 last_owner with nothing written. The change, its
// audit event and, when the member is the caller, the rotation of the session's token are one transaction, so a
// refusal at the commit leaves the old token and the old role; the new token travels in Set-Cookie only when
// the change is the caller's own (doc 04 section 4.3). The removal is an admin's as well (an owner's for an
// owner) and ends the membership as departure.ts describes.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "No such resource.";
const NO_SUCH_MEMBER = "There is no such member.";
const NOT_ALLOWED = "Your role does not allow this change.";
const LAST_OWNER = "A workspace always has an owner; make another member an owner first.";

export interface MemberRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
  readonly cookie: SessionCookieSpec;
}

function sessionOf(context: ChainContext): { readonly sessionId: string; readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal;
}

/** The workspace the request acts in; the authorization stage has already answered 404 for a request that acts in none. */
function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The member as the contract's `Member` schema has it. */
export function memberBody(member: WorkspaceMember): z.input<typeof MemberSchema> {
  const { accountId, displayName, email, role, joinedAt, lastActiveAt } = member;
  return { accountId, displayName, email, role, joinedAt: joinedAt.toISOString(), lastActiveAt: lastActiveAt === null ? null : lastActiveAt.toISOString() };
}

export function memberRoutes({ cursorSecret, cookie }: MemberRoutesOptions): RouteBinding[] {
  const cursors = createPageCursorCodec(cursorSecret, "members");
  return [
    route(listMembers).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      let afterId: string | null = null;
      if (query.cursor !== undefined) {
        const decoded = cursors.decode(query.cursor, tenant.workspaceId);
        if (decoded === undefined || !z.uuid().safeParse(decoded).success) {
          throw new ProblemError("bad_request", "The cursor is not valid.");
        }
        afterId = decoded;
      }
      // One more than the page, to know whether another page follows.
      const fetched = await tenant.withTenant((tx) => memberRepository(tx).list(afterId, query.limit + 1));
      const members = fetched.slice(0, query.limit);
      const last = members.at(-1);
      return {
        status: 200,
        body: {
          items: members.map(memberBody),
          nextCursor: fetched.length > query.limit && last !== undefined ? cursors.encode(last.accountId, tenant.workspaceId) : null,
        },
      };
    }),

    route(updateMember).handle(async ({ params, body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const tenant = tenantOf(context);
      const targetAccountId = params.accountId.toLowerCase();
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const token = newSessionToken();
      let result;
      try {
        result = await tenant.withTenant(async (tx) => {
          const profile = await accountProfileRepository(tx).profile();
          if (profile === undefined) {
            return { kind: "unavailable" } as const;
          }
          const repository = memberRepository(tx);
          const actor: AuditActor = { type: "account", accountId, label: profile.displayName };
          const outcome = await changeMemberRole(
            { store: repository, audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
            { workspaceId: tenant.workspaceId, actor, actorAccountId: accountId, targetAccountId, role: body.role, ipPrefix },
          );
          if (outcome.kind === "forbidden" || outcome.kind === "not_found") {
            return outcome;
          }
          const rotated = outcome.kind === "changed" && outcome.self;
          if (rotated && !(await repository.rotateSession(sessionId, token.hash))) {
            throw new ProblemError("unauthenticated", UNAUTHENTICATED);
          }
          const member = await repository.member(targetAccountId);
          return member === undefined ? ({ kind: "not_found" } as const) : ({ kind: "done", member, rotated } as const);
        });
      } catch (error) {
        // The database refuses the commit of a transaction that leaves the workspace without an owner: the role, the audit event and the new token are not written.
        if (isLastOwnerViolation(error)) {
          throw new ProblemError("last_owner", LAST_OWNER);
        }
        throw error;
      }
      switch (result.kind) {
        case "forbidden":
          throw new ProblemError("forbidden", NOT_ALLOWED);
        case "not_found":
        case "unavailable":
          throw new ProblemError("not_found", NO_SUCH_MEMBER);
        case "done":
          return { status: 200, body: memberBody(result.member), ...(result.rotated ? { headers: { "Set-Cookie": setSessionCookie(cookie, token.value) } } : {}) };
      }
    }),

    route(removeMember).handle(async ({ params, body }, context) => ({
      status: 200,
      body: await endMembershipOf(context, { targetAccountId: params.accountId.toLowerCase(), content: body.content, transferTo: body.transferTo }),
    })),
  ];
}
