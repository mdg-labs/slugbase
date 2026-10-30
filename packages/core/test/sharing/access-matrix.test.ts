import { describe, expect, it } from "vitest";
import {
  createAuditWriter,
  deleteBookmark,
  fileBookmarks,
  grantBookmarkShare,
  listBookmarkShares,
  openBookmark,
  readBookmark,
  revokeBookmarkShare,
  unfileBookmarks,
  updateBookmark,
  type AuditRecord,
  type BookmarkRecord,
  type BookmarkSharedVia,
  type BookmarkShareRecord,
  type BookmarkShareStore,
  type BookmarkStore,
  type FolderFilingStore,
  type FolderRecord,
} from "../../src/index.ts";
import { ACTIONS, expected, type Action, type Outcome, type Relation } from "./access-oracle.ts";

// The within-workspace access matrix of doc 02 section 8.2 through the services of core (doc 08 section 3.3, doc 10 T2, T11 and T12). Every cell of the
// oracle (`access-oracle.ts`, which states the table itself and imports nothing from the code judged here) is asked of the service that decides it, once for
// each operation that performs the action, over stores that answer from a small world: one bookmark of its owner, and for each member the route, if any,
// by which it reads it. The stores keep the rules of the real ones that the services lean on (a write finds only the owner's bookmark; the access probes
// say whether a bookmark is shared with the account) and nothing else, so what the table judges is the decision of the service: who may write, who is
// told `forbidden` and who `not_found`. The access predicate over the database (who reads through which share) and a member who has left, whom no
// service is ever asked for, are judged by the server suite over real rows.

const OWNER = "0192f3a0-bbbb-7000-8000-0000000000a1";
const BOOKMARK = "0192f3a0-aaaa-7000-8000-0000000000b1";
const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const SHARE = "0192f3a0-dddd-7000-8000-0000000000d1";
const OTHER_MEMBER = "0192f3a0-bbbb-7000-8000-0000000000a9";
const TEAM = "0192f3a0-cccc-7000-8000-0000000000c1";
const TAG = "0192f3a0-ffff-7000-8000-0000000000f1";
const NOW = new Date("2026-10-30T05:00:00.000Z");

/** The members of the world, one for each relation the services can tell apart; the route is what the world knows of them, not the oracle's verdict. */
const MEMBERS: Readonly<Record<Exclude<Relation, "former">, { readonly id: string; readonly route: BookmarkSharedVia | undefined }>> = {
  owner: { id: OWNER, route: undefined },
  direct: { id: "0192f3a0-bbbb-7000-8000-0000000000a2", route: "direct" },
  team: { id: "0192f3a0-bbbb-7000-8000-0000000000a3", route: "team" },
  folder: { id: "0192f3a0-bbbb-7000-8000-0000000000a4", route: "folder" },
  none: { id: "0192f3a0-bbbb-7000-8000-0000000000a5", route: undefined },
  // The services know nothing of roles: an admin with no share reads what any member with no share reads.
  admin: { id: "0192f3a0-bbbb-7000-8000-0000000000a6", route: undefined },
};

/** The relations a service can tell apart. A member who left is judged over the database by the server suite: no service is ever asked for them. */
const SERVICE_RELATIONS = Object.keys(MEMBERS) as readonly Exclude<Relation, "former">[];

function record(sharedVia: BookmarkSharedVia | null): BookmarkRecord {
  return {
    id: BOOKMARK,
    ownerId: OWNER,
    url: "https://example.com/docs",
    host: "example.com",
    title: "Docs",
    description: null,
    slug: "docs",
    forwarding: true,
    pinned: sharedVia === null,
    openCount: 0,
    lastOpenedAt: null,
    owner: sharedVia === null ? null : { accountId: OWNER, displayName: "Olga Owner" },
    sharedVia,
    folders: [],
    tags: [],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const FOLDER: FolderRecord = {
  id: "0192f3a0-9999-7000-8000-0000000000e1",
  ownerId: OWNER,
  name: "Reading",
  icon: "folder",
  color: 1,
  bookmarkCount: 1,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  owner: null,
  shareSummary: null,
};

function shareRecord(): BookmarkShareRecord {
  return { id: SHARE, bookmarkId: BOOKMARK, accountId: OTHER_MEMBER, teamId: null, name: "Max Member", email: "max@example.test", createdAt: NOW };
}

/** What a store was asked to write. Empty after a request that was refused. */
type Writes = string[];

/** The stores of one request: the account of the transaction is `accountId`, as it is for the real ones. */
function world(accountId: string) {
  const writes: Writes = [];
  const opens: string[] = [];
  const route = Object.values(MEMBERS).find((member) => member.id === accountId)?.route;
  const owns = accountId === OWNER;
  const readable = owns || route !== undefined;

  const bookmarks: Pick<BookmarkStore, "find" | "sharedWith" | "update" | "remove"> = {
    find: (id) => Promise.resolve(id === BOOKMARK && readable ? record(owns ? null : (route ?? null)) : undefined),
    sharedWith: (request) => Promise.resolve(request.bookmarkId === BOOKMARK && request.accountId === accountId && !owns && route !== undefined),
    update: (request) => {
      if (request.bookmarkId !== BOOKMARK || request.ownerId !== OWNER) {
        return Promise.resolve({ kind: "not_found" });
      }
      writes.push("update");
      return Promise.resolve({ kind: "updated", bookmark: record(null) });
    },
    remove: (request) => {
      if (request.bookmarkId !== BOOKMARK || request.ownerId !== OWNER) {
        return Promise.resolve(false);
      }
      writes.push("remove");
      return Promise.resolve(true);
    },
  };

  const shares: Pick<BookmarkShareStore, "ownedBookmark" | "sharedWith" | "list" | "grant" | "revoke"> = {
    ownedBookmark: (request) => Promise.resolve(request.bookmarkId === BOOKMARK && request.ownerId === OWNER),
    sharedWith: bookmarks.sharedWith,
    list: () => Promise.resolve({ shares: [shareRecord()], audienceSize: 1 }),
    grant: () => {
      writes.push("grant");
      return Promise.resolve({ kind: "granted", share: shareRecord() });
    },
    revoke: () => {
      writes.push("revoke");
      return Promise.resolve(shareRecord());
    },
  };

  // The store files and unfiles for the owner of the bookmarks named only, as the real one does: it finds every bookmark by identifier and owner.
  const filing: FolderFilingStore = {
    file: (request) => {
      if (!request.bookmarkIds.every((id) => id === BOOKMARK && request.ownerId === OWNER)) {
        return Promise.resolve({ kind: "not_found" });
      }
      writes.push("file");
      return Promise.resolve({ kind: "done", folder: FOLDER, changed: 1 });
    },
    unfile: (request) => {
      if (!request.bookmarkIds.every((id) => id === BOOKMARK && request.ownerId === OWNER)) {
        return Promise.resolve({ kind: "not_found" });
      }
      writes.push("unfile");
      return Promise.resolve({ kind: "done", folder: FOLDER, changed: 1 });
    },
    sharedAmong: (request) => Promise.resolve(request.bookmarkIds.includes(BOOKMARK) && !owns && route !== undefined ? [BOOKMARK] : []),
    sharedWith: () => Promise.resolve(false),
  };

  const audits: AuditRecord[] = [];
  const audit = createAuditWriter({
    store: {
      insert: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    },
    newId: () => "0192f3a0-eeee-7000-8000-000000000001",
  });
  return { writes, opens, audits, bookmarks, shares, filing, audit, usage: { record: (id: string) => void opens.push(id) } };
}

type World = ReturnType<typeof world>;

/** The kinds of answer a service gives, as the oracle's outcomes. */
function outcomeOf(kind: string): Outcome {
  switch (kind) {
    case "updated":
    case "unchanged":
    case "deleted":
    case "done":
    case "granted":
    case "existing":
    case "revoked":
    case "listed":
    case "opened":
      return "allowed";
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    default:
      throw new Error(`a service answered ${kind}, which no cell of the matrix expects`);
  }
}

interface Probe {
  /** The operation that performs the action, as the HTTP operations reach it. */
  readonly name: string;
  readonly run: (accountId: string, w: World) => Promise<Outcome>;
  /** What a request that is allowed must have written. */
  readonly writes?: string;
}

const OWNER_ASK = { workspaceId: WORKSPACE, ipPrefix: null } as const;
const actorOf = (accountId: string) => ({ type: "account", accountId, label: "Member" }) as const;

const update = (patch: Parameters<typeof updateBookmark>[1]["patch"]): Probe["run"] => async (accountId, w) =>
  outcomeOf((await updateBookmark({ store: w.bookmarks, newId: () => TAG }, { bookmarkId: BOOKMARK, accountId, patch, expectedVersions: undefined })).kind);

/** For each action, the operations that perform it. */
const PROBES: Readonly<Record<Action, readonly Probe[]>> = {
  see: [
    {
      name: "read the bookmark",
      run: async (accountId, w) => ((await readBookmark({ store: w.bookmarks }, { bookmarkId: BOOKMARK, accountId })) === undefined ? "hidden" : "allowed"),
    },
  ],
  open: [
    {
      name: "open the bookmark",
      run: async (accountId, w) => {
        const outcome = outcomeOf((await openBookmark({ store: w.bookmarks, usage: w.usage }, { bookmarkId: BOOKMARK, accountId })).kind);
        // An open counts for exactly the members it is allowed to.
        expect(w.opens).toEqual(outcome === "allowed" ? [BOOKMARK] : []);
        return outcome;
      },
    },
  ],
  edit: [
    { name: "change the title", run: update({ title: "Another title" }), writes: "update" },
    { name: "change the address", run: update({ url: "https://example.com/elsewhere" }), writes: "update" },
    { name: "change the slug and forwarding", run: update({ slug: "elsewhere", forwarding: false }), writes: "update" },
  ],
  pin: [{ name: "pin the bookmark", run: update({ pinned: true }), writes: "update" }],
  tag: [
    { name: "tag by identifier", run: update({ tagIds: [TAG] }), writes: "update" },
    { name: "tag by name", run: update({ tagNames: ["reading"] }), writes: "update" },
  ],
  file: [
    { name: "file through the bookmark", run: update({ folderIds: [FOLDER.id] }), writes: "update" },
    {
      name: "file into a folder of their own",
      run: async (accountId, w) => outcomeOf((await fileBookmarks({ store: w.filing }, { folderId: FOLDER.id, accountId, bookmarkIds: [BOOKMARK] })).kind),
      writes: "file",
    },
    {
      name: "take out of a folder of their own",
      run: async (accountId, w) => outcomeOf((await unfileBookmarks({ store: w.filing }, { folderId: FOLDER.id, accountId, bookmarkIds: [BOOKMARK] })).kind),
      writes: "unfile",
    },
  ],
  delete: [
    {
      name: "delete the bookmark",
      run: async (accountId, w) => outcomeOf((await deleteBookmark({ store: w.bookmarks }, { bookmarkId: BOOKMARK, accountId })).kind),
      writes: "remove",
    },
  ],
  share: [
    {
      name: "share with a member",
      run: async (accountId, w) =>
        outcomeOf((await grantBookmarkShare({ store: w.shares, audit: w.audit, newId: () => SHARE }, { ...OWNER_ASK, actor: actorOf(accountId), bookmarkId: BOOKMARK, target: { kind: "member", accountId: OTHER_MEMBER } })).kind),
      writes: "grant",
    },
    {
      name: "share with a team",
      run: async (accountId, w) =>
        outcomeOf((await grantBookmarkShare({ store: w.shares, audit: w.audit, newId: () => SHARE }, { ...OWNER_ASK, actor: actorOf(accountId), bookmarkId: BOOKMARK, target: { kind: "team", teamId: TEAM } })).kind),
      writes: "grant",
    },
    {
      name: "revoke a share",
      run: async (accountId, w) => outcomeOf((await revokeBookmarkShare({ store: w.shares, audit: w.audit }, { ...OWNER_ASK, actor: actorOf(accountId), bookmarkId: BOOKMARK, shareId: SHARE })).kind),
      writes: "revoke",
    },
  ],
  "see-recipients": [
    {
      name: "list the shares",
      run: async (accountId, w) => outcomeOf((await listBookmarkShares({ store: w.shares }, { accountId, bookmarkId: BOOKMARK })).kind),
    },
  ],
};

describe("the access matrix of doc 02 section 8.2, through the services", () => {
  it("has a probe for every row of the oracle", () => {
    expect(Object.keys(PROBES).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) {
      expect(PROBES[action].length, action).toBeGreaterThan(0);
    }
  });

  for (const relation of SERVICE_RELATIONS) {
    describe(`a ${relation}`, () => {
      for (const action of ACTIONS) {
        for (const probe of PROBES[action]) {
          it(`${action}: ${probe.name} is ${expected(relation, action)}`, async () => {
            const accountId = MEMBERS[relation].id;
            const w = world(accountId);

            const outcome = await probe.run(accountId, w);

            expect(outcome).toBe(expected(relation, action));
            // Only an allowed request writes, and an allowed request that changes something writes what it should: the cell is not vacuous.
            expect(w.writes).toEqual(outcome === "allowed" && probe.writes !== undefined ? [probe.writes] : []);
            if (outcome !== "allowed") {
              expect(w.audits).toEqual([]);
            }
          });
        }
      }
    });
  }

  it("does not hand a record to a reader whom the store should not have answered", async () => {
    // Defence in depth: a store that answers the owner's own bookmark (no share on it) to someone else is not believed.
    const w = world(MEMBERS.none.id);
    const leaky = { find: () => Promise.resolve(record(null)) };

    expect(await readBookmark({ store: leaky }, { bookmarkId: BOOKMARK, accountId: MEMBERS.none.id })).toBeUndefined();
    expect(await openBookmark({ store: leaky, usage: w.usage }, { bookmarkId: BOOKMARK, accountId: MEMBERS.none.id })).toEqual({ kind: "not_found" });
    expect(w.opens).toEqual([]);
  });
});
