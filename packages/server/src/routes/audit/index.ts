import { listAuditEvents as listAuditEventsOperation, type AuditEventSchema } from "@slugbase/contracts";
import { auditCategoryOf, listAuditEvents, type AuditCursors, type AuditEventRecord } from "@slugbase/core";
import { auditEventRepository } from "@slugbase/db";
import { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/audit-events (doc 04 section 10.5, doc 02 section 10, doc 05 section 2.9, doc 10 T1 and T11). The operation is an admin's or an
// owner's and carries the `audit.log` entitlement, both of which the authorization stage checks before this handler runs, and it declares no
// token scope, so a token never reaches it. It reads the audit log of the workspace the request is bound to: the repository names that
// workspace in its statement and the policy of the table keeps the statement to it, so an event of another workspace, and an event of the
// deployment, which has no workspace, are in no answer whatever the filters or the cursor say. A page is newest first, with the identifier
// as the tiebreak; the cursor is the position of the last event, signed for the workspace and the filters it was issued for, and a cursor
// presented with other filters, for another workspace or forged is `400 bad_request`.

const NO_WORKSPACE = "No such resource.";
const BAD_CURSOR = "The cursor is not valid.";

/** The text a database timestamp has as the repository reads it: RFC 3339 UTC with six decimals. */
const POSITION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function auditCursors(secret: string): AuditCursors {
  const codec = createPageCursorCodec(secret, "audit-events");
  return {
    seal: (position, scope) => codec.encodeKey([position.createdAt, position.id], scope),
    open(cursor, scope) {
      const [createdAt, id, ...rest] = codec.decodeKey(cursor, scope) ?? [];
      if (rest.length > 0 || typeof createdAt !== "string" || typeof id !== "string") {
        return undefined;
      }
      return POSITION_TIME.test(createdAt) && z.uuid().safeParse(id).success ? { createdAt, id } : undefined;
    },
  };
}

/** The workspace the request acts in; the authorization stage has already answered 404 for a request that acts in none. */
function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The event as the contract's `AuditEvent` schema has it: the actor and what the change was about, and no network. */
function auditEventBody(event: AuditEventRecord): z.input<typeof AuditEventSchema> {
  return {
    id: event.id,
    createdAt: event.createdAt,
    actor: { type: event.actorType, accountId: event.actorAccountId, label: event.actorLabel },
    action: event.action,
    category: auditCategoryOf(event.action),
    entity: event.entityType !== null && event.entityId !== null ? { type: event.entityType, id: event.entityId } : null,
    metadata: { ...event.metadata },
  };
}

export interface AuditRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

export function auditRoutes({ cursorSecret }: AuditRoutesOptions): RouteBinding[] {
  const cursors = auditCursors(cursorSecret);
  return [
    route(listAuditEventsOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        listAuditEvents(
          { store: auditEventRepository(tx), cursors },
          {
            workspaceId: tenant.workspaceId,
            actorAccountId: query.actorAccountId,
            actions: query.action === undefined ? undefined : typeof query.action === "string" ? [query.action] : query.action,
            category: query.category,
            entityType: query.entityType,
            entityId: query.entityId,
            from: query.from,
            to: query.to,
            limit: query.limit,
            cursor: query.cursor,
          },
        ),
      );
      if (outcome.kind === "bad_cursor") {
        throw new ProblemError("bad_request", BAD_CURSOR);
      }
      return { status: 200, body: { items: outcome.items.map(auditEventBody), nextCursor: outcome.nextCursor } };
    }),
  ];
}
