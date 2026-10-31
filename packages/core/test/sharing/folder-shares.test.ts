import { describe, expect, it } from "vitest";
import { createAuditWriter, grantFolderShare, listFolderShares, revokeFolderShare, type AuditRecord, type FolderShareRecord, type FolderShareStore, type FolderStore } from "../../src/index.ts";

// The services of the shares of a folder (doc 02 section 8, doc 04 section 10.7, doc 10 T2 and T11) over stores that record what they are asked.

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const FOLDER = "0192f3a0-aaaa-7000-8000-0000000000b1";
const OWNER = "0192f3a0-bbbb-7000-8000-0000000000a1";
const MEMBER = "0192f3a0-bbbb-7000-8000-0000000000a2";
const TEAM = "0192f3a0-cccc-7000-8000-0000000000c1";
const SHARE = "0192f3a0-dddd-7000-8000-0000000000d1";
const NOW = new Date("2026-10-29T05:00:00.000Z");
const ACTOR = { type: "account", accountId: OWNER, label: "Olga Owner" } as const;
const ask = { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: "203.0.0.0/16", folderId: FOLDER };

function memberShare(accountId = MEMBER, id = SHARE): FolderShareRecord {
  return { id, folderId: FOLDER, accountId, teamId: null, name: "Max Member", email: "max@example.test", createdAt: NOW };
}

function teamShare(teamId = TEAM, id = SHARE): FolderShareRecord {
  return { id, folderId: FOLDER, accountId: null, teamId, name: "Design", email: null, createdAt: NOW };
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

/** A store that records what it is asked and answers what the test says; the folder belongs to OWNER unless the test says otherwise. */
function store(answers: Partial<FolderShareStore> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const record = <T>(method: string, request: unknown, answer: T): Promise<T> => {
    calls.push({ method, request });
    return Promise.resolve(answer);
  };
  const dependencies: FolderShareStore = {
    ownedFolder: answers.ownedFolder ?? ((request) => record("ownedFolder", request, request.ownerId === OWNER && request.folderId === FOLDER)),
    list: answers.list ?? ((folderId) => record("list", folderId, { shares: [memberShare()], audienceSize: 1 })),
    grant: answers.grant ?? ((request) => record("grant", request, { kind: "granted", share: memberShare() } as const)),
    revoke: answers.revoke ?? ((request) => record<FolderShareRecord | undefined>("revoke", request, memberShare())),
  };
  return { calls, store: dependencies };
}

const newId = () => SHARE;

/** The folders of the workspace, as far as the shares need them: whether the folder is shared with the caller. Nobody has it shared with them unless the test says so. */
function folderStore(sharedWith: readonly string[] = []) {
  const asked: { folderId: string; accountId: string }[] = [];
  const folders: Pick<FolderStore, "sharedWith"> = {
    sharedWith: (request) => {
      asked.push(request);
      return Promise.resolve(request.folderId === FOLDER && sharedWith.includes(request.accountId));
    },
  };
  return { asked, folders };
}

describe("listFolderShares", () => {
  it("lists the shares of a folder of the caller", async () => {
    const { store: shares, calls } = store();
    expect(await listFolderShares({ store: shares, folders: folderStore().folders }, { accountId: OWNER, folderId: FOLDER })).toEqual({ kind: "listed", list: { shares: [memberShare()], audienceSize: 1 } });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder", "list"]);
    expect(calls[0]?.request).toEqual({ folderId: FOLDER, ownerId: OWNER, use: "read" });
  });

  it("reads nothing of a folder that is not the caller's", async () => {
    const { store: shares, calls } = store();
    expect(await listFolderShares({ store: shares, folders: folderStore().folders }, { accountId: MEMBER, folderId: FOLDER })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder"]);
  });
});

describe("grantFolderShare", () => {
  it("shares with a member and records share.granted with the kind, the identifier and the name of the target, and nothing of the folder", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    const outcome = await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } });
    expect(outcome).toEqual({ kind: "granted", share: memberShare() });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder", "grant"]);
    expect(calls[0]?.request).toEqual({ folderId: FOLDER, ownerId: OWNER, use: "grant" });
    expect(calls[1]?.request).toEqual({ id: SHARE, folderId: FOLDER, grantedBy: OWNER, target: { kind: "member", accountId: MEMBER } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "share.granted",
      workspaceId: WORKSPACE,
      actorAccountId: OWNER,
      entityType: "folder",
      entityId: FOLDER,
      metadata: { targetKind: "member", targetId: MEMBER, targetName: "Max Member" },
      ipPrefix: "203.0.0.0/16",
    });
  });

  it("shares with a team and names the team", async () => {
    const { store: shares } = store({ grant: () => Promise.resolve({ kind: "granted", share: teamShare() }) });
    const { audit, records } = auditor();
    expect((await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "team", teamId: TEAM } })).kind).toBe("granted");
    expect(records[0]?.metadata).toEqual({ targetKind: "team", targetId: TEAM, targetName: "Design" });
  });

  it("answers the share that exists for a repeated grant and records nothing", async () => {
    const { store: shares } = store({ grant: () => Promise.resolve({ kind: "existing", share: memberShare() }) });
    const { audit, records } = auditor();
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "existing", share: memberShare() });
    expect(records).toEqual([]);
  });

  it("writes nothing for a folder that is not the caller's, whatever the target", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    const stranger = { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max Member" } } as const;
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...stranger, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "not_found" });
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...stranger, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder", "ownedFolder"]);
    expect(records).toEqual([]);
  });

  it("refuses the owner as the target before it writes", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "member", accountId: OWNER } })).toEqual({ kind: "self" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder"]);
    expect(records).toEqual([]);
  });

  it("refuses the owner as the target however the id is spelled, before it writes", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "member", accountId: OWNER.toUpperCase() } })).toEqual({ kind: "self" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder"]);
    expect(records).toEqual([]);
  });

  it("answers an unknown target as the field that named it, and records nothing", async () => {
    const { store: shares } = store({ grant: () => Promise.resolve({ kind: "unknown_target" }) });
    const { audit, records } = auditor();
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "unknown_target", field: "accountId" });
    expect(await grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "unknown_target", field: "teamId" });
    expect(records).toEqual([]);
  });

  it("lets a failing audit write end the grant with the error, so the transaction that holds the share rolls it back", async () => {
    const { store: shares } = store();
    const audit = createAuditWriter({ store: { insert: () => Promise.reject(new Error("the log is down")) }, newId });
    await expect(grantFolderShare({ store: shares, folders: folderStore().folders, audit, newId }, { ...ask, target: { kind: "member", accountId: MEMBER } })).rejects.toThrow("the log is down");
  });
});

describe("revokeFolderShare", () => {
  it("revokes a share of a folder of the caller and records share.revoked with the name the target had", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await revokeFolderShare({ store: shares, folders: folderStore().folders, audit }, { ...ask, shareId: SHARE })).toEqual({ kind: "revoked", share: memberShare() });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder", "revoke"]);
    expect(calls[0]?.request).toEqual({ folderId: FOLDER, ownerId: OWNER, use: "revoke" });
    expect(calls[1]?.request).toEqual({ folderId: FOLDER, shareId: SHARE });
    expect(records[0]).toMatchObject({
      action: "share.revoked",
      entityType: "folder",
      entityId: FOLDER,
      metadata: { targetKind: "member", targetId: MEMBER, targetName: "Max Member" },
    });
  });

  it("names a team by its identifier", async () => {
    const { store: shares } = store({ revoke: () => Promise.resolve(teamShare()) });
    const { audit, records } = auditor();
    await revokeFolderShare({ store: shares, folders: folderStore().folders, audit }, { ...ask, shareId: SHARE });
    expect(records[0]?.metadata).toEqual({ targetKind: "team", targetId: TEAM, targetName: "Design" });
  });

  it("revokes nothing of a folder that is not the caller's, and records nothing for a share that is not there", async () => {
    const { store: shares, calls } = store();
    const { audit, records } = auditor();
    expect(await revokeFolderShare({ store: shares, folders: folderStore().folders, audit }, { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max" }, shareId: SHARE })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder"]);
    const { store: empty } = store({ revoke: () => Promise.resolve(undefined) });
    expect(await revokeFolderShare({ store: empty, folders: folderStore().folders, audit }, { ...ask, shareId: SHARE })).toEqual({ kind: "not_found" });
    expect(records).toEqual([]);
  });
});

describe("a folder that is shared with the caller", () => {
  const recipient = { ...ask, actor: { type: "account", accountId: MEMBER, label: "Max Member" } } as const;

  it("is forbidden from the list, asking only the owner check and the probe", async () => {
    const { store: shares, calls } = store();
    const { asked, folders } = folderStore([MEMBER]);
    expect(await listFolderShares({ store: shares, folders }, { accountId: MEMBER, folderId: FOLDER })).toEqual({ kind: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder"]);
    expect(asked).toEqual([{ folderId: FOLDER, accountId: MEMBER }]);
  });

  it("is forbidden from a grant, whatever the target, and writes and records nothing", async () => {
    const { store: shares, calls } = store();
    const { folders } = folderStore([MEMBER]);
    const { audit, records } = auditor();
    expect(await grantFolderShare({ store: shares, folders, audit, newId }, { ...recipient, target: { kind: "member", accountId: TEAM } })).toEqual({ kind: "forbidden" });
    expect(await grantFolderShare({ store: shares, folders, audit, newId }, { ...recipient, target: { kind: "member", accountId: MEMBER } })).toEqual({ kind: "forbidden" });
    expect(await grantFolderShare({ store: shares, folders, audit, newId }, { ...recipient, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder", "ownedFolder", "ownedFolder"]);
    expect(records).toEqual([]);
  });

  it("is forbidden from a revocation before the share is looked up, so a share that is not there reveals nothing more", async () => {
    const { store: shares, calls } = store();
    const { folders } = folderStore([MEMBER]);
    const { audit, records } = auditor();
    expect(await revokeFolderShare({ store: shares, folders, audit }, { ...recipient, shareId: SHARE })).toEqual({ kind: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder"]);
    expect(records).toEqual([]);
  });

  it("is not asked about when the caller owns the folder", async () => {
    const { store: shares } = store();
    const { asked, folders } = folderStore([OWNER]);
    await listFolderShares({ store: shares, folders }, { accountId: OWNER, folderId: FOLDER });
    expect(asked).toEqual([]);
  });

  it("is not_found for a caller it is not shared with, whatever the operation", async () => {
    const { store: shares, calls } = store();
    const { folders } = folderStore([TEAM]);
    const { audit, records } = auditor();
    expect(await listFolderShares({ store: shares, folders }, { accountId: MEMBER, folderId: FOLDER })).toEqual({ kind: "not_found" });
    expect(await grantFolderShare({ store: shares, folders, audit, newId }, { ...recipient, target: { kind: "team", teamId: TEAM } })).toEqual({ kind: "not_found" });
    expect(await revokeFolderShare({ store: shares, folders, audit }, { ...recipient, shareId: SHARE })).toEqual({ kind: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["ownedFolder", "ownedFolder", "ownedFolder"]);
    expect(records).toEqual([]);
  });

  it("lets an error of the probe end the request with the error, never with an answer", async () => {
    const { store: shares } = store();
    const folders: Pick<FolderStore, "sharedWith"> = { sharedWith: () => Promise.reject(new Error("the folders are down")) };
    const { audit } = auditor();
    await expect(listFolderShares({ store: shares, folders }, { accountId: MEMBER, folderId: FOLDER })).rejects.toThrow("the folders are down");
    await expect(grantFolderShare({ store: shares, folders, audit, newId }, { ...recipient, target: { kind: "team", teamId: TEAM } })).rejects.toThrow("the folders are down");
    await expect(revokeFolderShare({ store: shares, folders, audit }, { ...recipient, shareId: SHARE })).rejects.toThrow("the folders are down");
  });
});
