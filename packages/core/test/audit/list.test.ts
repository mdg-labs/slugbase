import { AUDIT_EVENT_CATEGORIES } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_CATEGORIES,
  auditCategoryOf,
  listAuditEvents,
  type AuditCursors,
  type AuditEventPosition,
  type AuditEventReader,
  type AuditEventRecord,
  type AuditListAsk,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-000000000001";
const OTHER_WORKSPACE = "0192f3a0-aaaa-7000-8000-000000000002";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";

function event(index: number, overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: `0192f3a0-eeee-7000-8000-${index.toString(16).padStart(12, "0")}`,
    createdAt: `2026-01-01T00:00:${String(60 - index).padStart(2, "0")}.000000Z`,
    actorType: "account",
    actorAccountId: ACCOUNT,
    actorLabel: "Ada",
    action: "workspace.renamed",
    entityType: "workspace",
    entityId: WORKSPACE,
    metadata: { from: "A", to: "B" },
    ...overrides,
  };
}

/** A store over a fixed log that applies the position and the limit as the database does and remembers what it was asked. */
function memoryStore(log: readonly AuditEventRecord[]): AuditEventReader & { readonly asked: Parameters<AuditEventReader["list"]>[0][] } {
  const asked: Parameters<AuditEventReader["list"]>[0][] = [];
  return {
    asked,
    list(query) {
      asked.push(query);
      const start = query.after === undefined ? 0 : log.findIndex((row) => row.id === query.after?.id) + 1;
      return Promise.resolve(log.slice(start, start + query.limit));
    },
  };
}

/** Cursors that seal the position and the scope in plain text, so a test sees what a cursor is bound to. */
const cursors: AuditCursors = {
  seal: (position, scope) => JSON.stringify({ position, scope }),
  open(cursor, scope) {
    const parsed = JSON.parse(cursor) as { position: AuditEventPosition; scope: string };
    return parsed.scope === scope ? parsed.position : undefined;
  },
};

function ask(overrides: Partial<AuditListAsk> = {}): AuditListAsk {
  return { workspaceId: WORKSPACE, limit: 2, cursor: undefined, ...overrides };
}

describe("listAuditEvents", () => {
  it("pages through the log with the position of the last event of a page, and ends with a null cursor", async () => {
    const log = [event(1), event(2), event(3), event(4), event(5)];
    const store = memoryStore(log);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const outcome = await listAuditEvents({ store, cursors }, ask({ cursor }));
      if (outcome.kind !== "listed") {
        throw new Error("the cursor of the previous page was refused");
      }
      seen.push(...outcome.items.map((item) => item.id));
      if (outcome.nextCursor === null) {
        break;
      }
      cursor = outcome.nextCursor;
    }
    expect(seen).toEqual(log.map((item) => item.id));
    expect(store.asked.map((query) => query.limit)).toEqual([3, 3, 3]);
  });

  it("refuses a cursor issued for other filters, another workspace or no scope at all, and reads nothing", async () => {
    const store = memoryStore([event(1), event(2), event(3)]);
    const first = await listAuditEvents({ store, cursors }, ask({ actions: ["workspace.renamed"], entityType: "workspace" }));
    if (first.kind !== "listed" || first.nextCursor === null) {
      throw new Error("the first page has a successor");
    }
    const reads = store.asked.length;
    const same = { actions: ["workspace.renamed"], entityType: "workspace" };
    const foreign: Partial<AuditListAsk>[] = [
      { ...same, entityType: "member" },
      { ...same, actions: ["member.removed"] },
      { ...same, category: "member" },
      { ...same, actorAccountId: ACCOUNT },
      { ...same, entityId: WORKSPACE },
      { ...same, from: "2026-01-01T00:00:00.000Z" },
      { ...same, to: "2026-02-01T00:00:00.000Z" },
      { ...same, workspaceId: OTHER_WORKSPACE },
      { actions: undefined, entityType: undefined },
    ];
    for (const overrides of foreign) {
      expect(await listAuditEvents({ store, cursors }, ask({ ...overrides, cursor: first.nextCursor }))).toEqual({ kind: "bad_cursor" });
    }
    expect(store.asked).toHaveLength(reads);
    expect(await listAuditEvents({ store, cursors }, ask({ ...same, cursor: first.nextCursor }))).toMatchObject({ kind: "listed" });
  });

  it("treats the same actions in another order, or twice, as one filter", async () => {
    const store = memoryStore([event(1), event(2), event(3)]);
    const first = await listAuditEvents({ store, cursors }, ask({ actions: ["workspace.renamed", "member.removed"] }));
    if (first.kind !== "listed" || first.nextCursor === null) {
      throw new Error("the first page has a successor");
    }
    const again = await listAuditEvents({ store, cursors }, ask({ actions: ["member.removed", "workspace.renamed", "member.removed"], cursor: first.nextCursor }));
    expect(again.kind).toBe("listed");
  });

  it("hands the store the actions of a category, and the named ones narrowed to it", async () => {
    const store = memoryStore([]);
    await listAuditEvents({ store, cursors }, ask({ category: "team" }));
    const team = AUDIT_ACTION_NAMES.filter((name) => AUDIT_ACTIONS[name].category === "team");
    expect(team.length).toBeGreaterThan(0);
    expect(store.asked.at(-1)?.actions).toEqual(team);

    const named = [team[0] ?? "", "member.removed", "no.such_action"];
    await listAuditEvents({ store, cursors }, ask({ category: "team", actions: named }));
    expect(store.asked.at(-1)?.actions).toEqual([team[0]]);

    await listAuditEvents({ store, cursors }, ask({ actions: ["workspace.renamed"] }));
    expect(store.asked.at(-1)?.actions).toEqual(["workspace.renamed"]);

    await listAuditEvents({ store, cursors }, ask());
    expect(store.asked.at(-1)).not.toHaveProperty("actions");
  });

  it("answers an empty page without asking the store when the actions and the category exclude each other", async () => {
    const store = memoryStore([event(1)]);
    const outcome = await listAuditEvents({ store, cursors }, ask({ category: "team", actions: ["workspace.renamed"] }));
    expect(outcome).toEqual({ kind: "listed", items: [], nextCursor: null });
    expect(store.asked).toEqual([]);
  });

  it("passes the filters to the store in the form it reads them, with identifiers in lower case", async () => {
    const store = memoryStore([]);
    await listAuditEvents(
      { store, cursors },
      ask({ actorAccountId: ACCOUNT.toUpperCase(), entityType: "bookmark", entityId: WORKSPACE.toUpperCase(), from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" }),
    );
    expect(store.asked.at(-1)).toEqual({
      actorAccountId: ACCOUNT,
      entityType: "bookmark",
      entityId: WORKSPACE,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      after: undefined,
      limit: 3,
    });
  });
});

describe("the categories of the log", () => {
  it("are the ones the contract filters by, and every action of the catalog has one of them", () => {
    expect([...AUDIT_CATEGORIES]).toEqual([...AUDIT_EVENT_CATEGORIES]);
    for (const name of AUDIT_ACTION_NAMES) {
      expect(auditCategoryOf(name)).toBe(AUDIT_ACTIONS[name].category);
    }
    expect(auditCategoryOf("retired.action")).toBeNull();
  });
});
