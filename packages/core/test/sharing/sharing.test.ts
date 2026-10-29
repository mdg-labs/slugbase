import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AuditMetadataError,
  createAuditWriter,
  findShareTargets,
  grantBookmarkShare,
  listBookmarkShares,
  parseAuditMetadata,
  revokeBookmarkShare,
  SHARE_ENTITLEMENTS,
  type AuditRecord,
  type BookmarkShareRecord,
  type BookmarkShareStore,
  type ShareTargetStore,
} from "../../src/index.ts";

// The services of sharing (doc 02 section 8, doc 04 section 10.7, doc 10 T2 and T11) over stores that record what they are asked.

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const BOOKMARK = "0192f3a0-aaaa-7000-8000-0000000000b1";
const OWNER = "0192f3a0-bbbb-7000-8000-0000000000a1";
const MEMBER = "0192f3a0-bbbb-7000-8000-0000000000a2";
const TEAM = "0192f3a0-cccc-7000-8000-0000000000c1";
const SHARE = "0192f3a0-dddd-7000-8000-0000000000d1";
const NOW = new Date("2026-10-29T05:00:00.000Z");
const ACTOR = { type: "account", accountId: OWNER, label: "Olga Owner" } as const;
const ask = { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: "203.0.0.0/16", bookmarkId: BOOKMARK };

function memberShare(accountId = MEMBER, id = SHARE): BookmarkShareRecord {
  return { id, bookmarkId: BOOKMARK, accountId, teamId: null, name: "Max Member", email: "max@example.test", createdAt: NOW };
}

function teamShare(teamId = TEAM, id = SHARE): BookmarkShareRecord {
  return { id, bookmarkId: BOOKMARK, accountId: null, teamId, name: "Design", email: null, createdAt: NOW };
}

function auditor() {
  const records: AuditRecord[] = [];
  let next = 0;
  return {
    records,
    audit: createAuditWriter({
      store: {
        insert: (record) => {
          records.push(record);
          return Promise.resolve();
        },
      },
      newId: () => `0192f3a0-eeee-7000-8000-${String((next += 1)).padStart(12, "0")}`,
    }),
  };
}

/** A store that records what it is asked and answers what the test says; the bookmark belongs to OWNER unless the test says otherwise. */
function store(answers: Partial<BookmarkShareStore> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const record = <T>(method: string, request: unknown, answer: T): Promise<T> => {
    calls.push({ method, request });
    return Promise.resolve(answer);
  };
  const dependencies: BookmarkShareStore = {
    ownedBookmark: answers.ownedBookmark ?? ((request) => record("ownedBookmark", request, request.ownerId === OWNER && request.bookmarkId === BOOKMARK)),
    sharedWith: answers.sharedWith ?? ((request) => record("sharedWith", request, false)),
    list: answers.list ?? ((bookmarkId) => record("list", bookmarkId, { shares: [memberShare()], audienceSize: 1 })),
    grant: answers.grant ?? ((request) => record("grant", request, { kind: "granted", share: memberShare() } as const)),
    revoke: answers.revoke ?? ((request) => record<BookmarkShareRecord | undefined>("revoke", request, memberShare())),
  };
  return { calls, store: dependencies };
}

const newId = () => SHARE;

describe("findShareTargets", () => {
  const targets = { kind: "member", id: MEMBER, name: "Max Member", email: "max@example.test" } as const;

  it("asks the store for the kinds it was given and answers what it finds", async () => {
    const asked: unknown[] = [];
    const store: ShareTargetStore = {
      search: (request) => {
        asked.push(request);
        return Promise.resolve([targets]);
      },
    };
    const search = { q: "ma", excludeAccountId: OWNER, kinds: ["member", "team"], limit: 20 } as const;
    expect(await findShareTargets({ store }, search)).toEqual([targets]);
    expect(asked).toEqual([search]);
  });

  it("asks nothing and offers nothing when the workspace holds the entitlement of no kind", async () => {
    const asked: unknown[] = [];
    const store: ShareTargetStore = {
      search: (request) => {
        asked.push(request);
        return Promise.resolve([targets]);
      },
    };
    expect(await findShareTargets({ store }, { q: undefined, excludeAccountId: OWNER, kinds: [], limit: 20 })).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("SHARE_ENTITLEMENTS", () => {
  it("names the entitlement of each kind of target", () => {
    expect(SHARE_ENTITLEMENTS).toEqual({ member: "sharing.members", team: "sharing.teams" });
  });
});

describe("listBookmarkShares", () => {
  it("lists the shares of a bookmark of the caller", async () => {
    const { store: shares, calls } = store();
    expect(await listBookmarkShares({ store: shares }, { accountId: OWNER, bookmarkId: BOOKMARK })).toEqual({ kind: "listed", list: { shares: [memberShare()], audienceSize: 1 } });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "list"]);
    expect(calls[0]?.request).toEqual({ bookmarkId: BOOKMARK, ownerId: OWNER, use: "read" });
  });

  it("reads nothing of a bookmark that is not the caller's", async () => {
    const { store: shares, calls } = store();
    expect(await listBookmarkShares({ store: shares }, { accountId: MEMBER, bookmarkId: BOOKMARK })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "sharedWith"]);
  });

  it("is forbidden, and reads nothing, for a bookmark that is shared with the caller", async () => {
    const { store: shares, calls } = store({ sharedWith: (request) => Promise.resolve(request.accountId === MEMBER) });
    expect(await listBookmarkShares({ store: shares }, { accountId: MEMBER, bookmarkId: BOOKMARK })).toEqual({ kind: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark"]);
  });
});

describe("grantBookmarkShare", () => {
  it("shares with a member and records share.granted with the kind, the identifier and the name of the target, and nothing of the bookmark", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    const outcome = await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } });
    expect(outcome).toEqual({ kind: "granted", share: memberShare() });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "grant"]);
    expect(calls[0]?.request).toEqual({ bookmarkId: BOOKMARK, ownerId: OWNER, use: "grant" });
    expect(calls[1]?.request).toEqual({ id: SHARE, bookmarkId: BOOKMARK, grantedBy: OWNER, target: { kind: "member", accountId: MEMBER } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "share.granted",
      workspaceId: WORKSPACE,
      actorAccountId: OWNER,
      entityType: "bookmark",
      entityId: BOOKMARK,
      metadata: { targetKind: "member", targetId: MEMBER, targetName: "Max Member" },
      ipPrefix: "203.0.0.0/16",
    });
  });

  it("shares with a team and names the team", async () => {
    const { store: shares } = store({ grant: () => Promise.resolve({ kind: "granted", share: teamShare() }) });
    const { audit, records } = auditor();
    expect((await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "team", teamId: TEAM } })).kind).toBe("granted");
    expect(records[0]?.metadata).toEqual({ targetKind: "team", targetId: TEAM, targetName: "Design" });
  });

  it("answers the share that exists for a repeated grant and records nothing", async () => {
    const { store: shares } = store({ grant: () => Promise.resolve({ kind: "existing", share: memberShare() }) });
    const { audit, records } = auditor();
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "existing", share: memberShare() });
    expect(records).toEqual([]);
  });

  it("writes nothing for a bookmark that is not the caller's, whatever the target", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    const stranger = { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max Member" } } as const;
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...stranger, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "not_found" });
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...stranger, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "sharedWith", "ownedBookmark", "sharedWith"]);
    expect(records).toEqual([]);
  });

  it("is forbidden, and writes nothing, for a bookmark that is shared with the caller, whatever the target", async () => {
    const { store: shares, calls } = store({ sharedWith: () => Promise.resolve(true) });
    const { audit, records } = auditor();
    const recipient = { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max Member" } } as const;
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...recipient, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "forbidden" });
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...recipient, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "ownedBookmark"]);
    expect(records).toEqual([]);
  });

  it("refuses the owner as the target before it writes", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "member", accountId: OWNER } })).toEqual({ kind: "self" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark"]);
    expect(records).toEqual([]);
  });

  it("refuses the owner as the target whatever the case of the identifier", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "member", accountId: OWNER.toUpperCase() } })).toEqual({ kind: "self" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark"]);
    expect(records).toEqual([]);
  });

  it("answers an unknown target as the field that named it, and records nothing", async () => {
    const { store: shares } = store({ grant: () => Promise.resolve({ kind: "unknown_target" }) });
    const { audit, records } = auditor();
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "unknown_target", field: "accountId" });
    expect(await grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "unknown_target", field: "teamId" });
    expect(records).toEqual([]);
  });

  it("lets a failing audit write end the grant with the error, so the transaction that holds the share rolls it back", async () => {
    const { store: shares } = store();
    const audit = createAuditWriter({ store: { insert: () => Promise.reject(new Error("the log is down")) }, newId });
    await expect(grantBookmarkShare({ store: shares, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } })).rejects.toThrow("the log is down");
  });
});

describe("revokeBookmarkShare", () => {
  it("revokes a share of a bookmark of the caller and records share.revoked with the name the target had", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await revokeBookmarkShare({ store: shares, audit }, { ...ask, shareId: SHARE })).toEqual({ kind: "revoked", share: memberShare() });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "revoke"]);
    expect(calls[0]?.request).toEqual({ bookmarkId: BOOKMARK, ownerId: OWNER, use: "revoke" });
    expect(calls[1]?.request).toEqual({ bookmarkId: BOOKMARK, shareId: SHARE });
    expect(records[0]).toMatchObject({
      action: "share.revoked",
      entityType: "bookmark",
      entityId: BOOKMARK,
      metadata: { targetKind: "member", targetId: MEMBER, targetName: "Max Member" },
    });
  });

  it("names a team by its identifier", async () => {
    const { store: shares } = store({ revoke: () => Promise.resolve(teamShare()) });
    const { audit, records } = auditor();
    await revokeBookmarkShare({ store: shares, audit }, { ...ask, shareId: SHARE });
    expect(records[0]?.metadata).toEqual({ targetKind: "team", targetId: TEAM, targetName: "Design" });
  });

  it("revokes nothing of a bookmark that is not the caller's, and records nothing for a share that is not there", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await revokeBookmarkShare({ store: shares, audit }, { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max" }, shareId: SHARE })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark", "sharedWith"]);
    const { store: empty } = store({ revoke: () => Promise.resolve(undefined) });
    expect(await revokeBookmarkShare({ store: empty, audit }, { ...ask, shareId: SHARE })).toEqual({ kind: "not_found" });
    expect(records).toEqual([]);
  });
});

describe("revokeBookmarkShare for a recipient", () => {
  it("is forbidden, and revokes and records nothing, for a bookmark that is shared with the caller", async () => {
    const { store: shares, calls } = store({ sharedWith: () => Promise.resolve(true) });
    const { audit, records } = auditor();
    expect(await revokeBookmarkShare({ store: shares, audit }, { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max" }, shareId: SHARE })).toEqual({ kind: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["ownedBookmark"]);
    expect(records).toEqual([]);
  });
});

describe("the audit actions of sharing", () => {
  it("are in the share category and carry the kind, the identifier and the name of the target and nothing else", () => {
    for (const action of ["share.granted", "share.revoked"] as const) {
      expect(AUDIT_ACTIONS[action].category).toBe("share");
      expect(Object.keys(AUDIT_ACTIONS[action].metadata)).toEqual(["targetKind", "targetId", "targetName"]);
    }
  });

  it("refuse a field for a title or an address, a target that is no identifier and a name of 101 characters", () => {
    const valid = { targetKind: "member", targetId: MEMBER, targetName: "Max Member" };
    expect(parseAuditMetadata("share.granted", valid)).toEqual(valid);
    expect(() => parseAuditMetadata("share.granted", { ...valid, title: "A private bookmark" })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("share.granted", { ...valid, targetId: "max@example.test" })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("share.revoked", { ...valid, targetName: "x".repeat(101) })).toThrow(AuditMetadataError);
    expect(parseAuditMetadata("share.revoked", { ...valid, targetName: "x".repeat(100) }).targetName).toHaveLength(100);
  });
});
