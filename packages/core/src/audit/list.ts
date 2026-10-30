import { AUDIT_ACTIONS, AUDIT_ACTION_NAMES, isAuditAction, type AuditCategory } from "./catalog.ts";

// Reading the audit log of a workspace (doc 02 section 10, doc 04 sections 6.1 and 10.5, doc 05 section 2.9). A page is a slice of one
// ordering, newest first with the identifier as the tiebreak, resumed by an opaque cursor that carries the last event's position: a keyset,
// never an offset. The cursor is signed for the workspace and the filters it was issued for, so it opens nothing else. The store reads the
// workspace of its transaction only; who may read the log and whether the workspace holds `audit.log` are decided before this runs.

/** One event of the log as it is read: the row without the network it was made from. */
export interface AuditEventRecord {
  readonly id: string;
  /** RFC 3339 UTC with the microseconds the database holds, which the position of the next page needs whole. */
  readonly createdAt: string;
  readonly actorType: "account" | "api_token" | "system";
  /** Null for the system and for an account deleted since. */
  readonly actorAccountId: string | null;
  /** The display name at the time; never rewritten. */
  readonly actorLabel: string;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Where a page resumes: the sort key of the last event of the one before. */
export interface AuditEventPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** What the store filters on; a field left out filters nothing. */
export interface AuditEventFilter {
  readonly actorAccountId?: string;
  /** Exact action names; any of them. */
  readonly actions?: readonly string[];
  readonly entityType?: string;
  readonly entityId?: string;
  /** Inclusive, RFC 3339. */
  readonly from?: string;
  /** Exclusive, RFC 3339. */
  readonly to?: string;
}

export interface AuditEventReader {
  /** The events after `after` that match the filter, newest first, at most `limit`, in the workspace of the transaction. */
  list(query: AuditEventFilter & { readonly after: AuditEventPosition | undefined; readonly limit: number }): Promise<readonly AuditEventRecord[]>;
}

/** Signs and opens cursors; a cursor opens only for the `scope` it was sealed with. */
export interface AuditCursors {
  seal(position: AuditEventPosition, scope: string): string;
  /** Undefined when the cursor was not sealed by this server for this scope. */
  open(cursor: string, scope: string): AuditEventPosition | undefined;
}

export interface AuditListDependencies {
  readonly store: AuditEventReader;
  readonly cursors: AuditCursors;
}

export interface AuditListAsk {
  readonly workspaceId: string;
  readonly actorAccountId?: string | undefined;
  readonly actions?: readonly string[] | undefined;
  readonly category?: AuditCategory | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** 1 to 100. */
  readonly limit: number;
  readonly cursor: string | undefined;
}

export type AuditListOutcome =
  | { readonly kind: "listed"; readonly items: readonly AuditEventRecord[]; readonly nextCursor: string | null }
  /** The cursor was not issued by this server for this workspace and these filters; nothing was read. */
  | { readonly kind: "bad_cursor" };

/** The category of an action of the catalog; null for a name it does not hold (an event written before the action was retired). */
export function auditCategoryOf(action: string): AuditCategory | null {
  return isAuditAction(action) ? AUDIT_ACTIONS[action].category : null;
}

/** The action names the filter admits: those named, narrowed to the category when one is given; undefined when neither narrows the log. */
function admittedActions(actions: readonly string[] | undefined, category: AuditCategory | undefined): readonly string[] | undefined {
  const inCategory = category === undefined ? undefined : AUDIT_ACTION_NAMES.filter((name) => AUDIT_ACTIONS[name].category === category);
  if (actions === undefined) {
    return inCategory;
  }
  const named = [...new Set(actions)].sort();
  return inCategory === undefined ? named : named.filter((name) => inCategory.some((member) => member === name));
}

/** What a cursor is bound to: the workspace and every filter, written so that no two different lists share a scope. */
function cursorScope(ask: AuditListAsk, actions: readonly string[] | undefined): string {
  return JSON.stringify([
    ask.workspaceId.toLowerCase(),
    ask.actorAccountId?.toLowerCase() ?? null,
    actions ?? null,
    ask.entityType ?? null,
    ask.entityId?.toLowerCase() ?? null,
    ask.from ?? null,
    ask.to ?? null,
  ]);
}

/** One page of the audit log of the workspace of the store's transaction, with the cursor of the next. */
export async function listAuditEvents({ store, cursors }: AuditListDependencies, ask: AuditListAsk): Promise<AuditListOutcome> {
  const actions = admittedActions(ask.actions, ask.category);
  const scope = cursorScope(ask, actions);
  let after: AuditEventPosition | undefined;
  if (ask.cursor !== undefined) {
    after = cursors.open(ask.cursor, scope);
    if (after === undefined) {
      return { kind: "bad_cursor" };
    }
  }
  // Filters that exclude every action match no event, whatever the log holds.
  if (actions?.length === 0) {
    return { kind: "listed", items: [], nextCursor: null };
  }
  // One more than the page, to know whether another page follows.
  const fetched = await store.list({
    ...(ask.actorAccountId === undefined ? {} : { actorAccountId: ask.actorAccountId.toLowerCase() }),
    ...(actions === undefined ? {} : { actions }),
    ...(ask.entityType === undefined ? {} : { entityType: ask.entityType }),
    ...(ask.entityId === undefined ? {} : { entityId: ask.entityId.toLowerCase() }),
    ...(ask.from === undefined ? {} : { from: ask.from }),
    ...(ask.to === undefined ? {} : { to: ask.to }),
    after,
    limit: ask.limit + 1,
  });
  const items = fetched.slice(0, ask.limit);
  const last = items.at(-1);
  return {
    kind: "listed",
    items,
    nextCursor: fetched.length > ask.limit && last !== undefined ? cursors.seal({ createdAt: last.createdAt, id: last.id }, scope) : null,
  };
}
