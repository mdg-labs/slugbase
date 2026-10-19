import { describe, expect, it } from "vitest";
import {
  changeWorkspaceSettings,
  createAuditWriter,
  renameWorkspace,
  type AuditRecord,
  type AuditStore,
  type WorkspaceAdministrationStore,
  type WorkspaceRenameRequest,
  type WorkspaceRenameResult,
  type WorkspaceSettings,
  type WorkspaceSettingsChange,
  type WorkspaceSettingsPatch,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const ACTOR = { type: "account", accountId: ACCOUNT, label: "Ada" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

interface WorldOptions {
  rename?: WorkspaceRenameResult;
  settings?: WorkspaceSettings | null;
  auditFails?: boolean;
}

/** The stores of one transaction: what they were asked for, in order, and the audit rows that stay when it ends. */
function world({ rename = { kind: "renamed", previousName: "Old", version: 2 }, settings = { aiEnabled: true }, auditFails = false }: WorldOptions = {}) {
  const log: string[] = [];
  const renames: WorkspaceRenameRequest[] = [];
  const patches: WorkspaceSettingsPatch[] = [];
  const audits: AuditRecord[] = [];
  const store: WorkspaceAdministrationStore = {
    rename(request) {
      log.push("rename");
      renames.push(request);
      return Promise.resolve(rename);
    },
    changeSettings(patch): Promise<WorkspaceSettingsChange | undefined> {
      log.push("settings");
      patches.push(patch);
      if (settings === null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ previous: settings, current: { aiEnabled: patch.aiEnabled ?? settings.aiEnabled } });
    },
  };
  const auditStore: AuditStore = {
    insert(record) {
      log.push("audit");
      if (auditFails) {
        return Promise.reject(new Error("the database refused"));
      }
      audits.push(record);
      return Promise.resolve();
    },
  };
  return { log, renames, patches, audits, dependencies: { store, audit: createAuditWriter({ store: auditStore, newId: ids() }) } };
}

const RENAME = { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: "203.0.0.0/16", name: "New", expectedVersions: undefined } as const;

describe("renameWorkspace", () => {
  it("renames and writes workspace.renamed with the old and the new name, in that order", async () => {
    const { dependencies, renames, audits, log } = world();

    const outcome = await renameWorkspace(dependencies, { ...RENAME, expectedVersions: [1] });

    expect(outcome).toEqual({ kind: "renamed", version: 2 });
    expect(renames).toEqual([{ name: "New", expectedVersions: [1] }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACCOUNT,
      actorLabel: "Ada",
      action: "workspace.renamed",
      entityType: "workspace",
      entityId: WORKSPACE,
      metadata: { from: "Old", to: "New" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(log).toEqual(["rename", "audit"]);
  });

  it("writes no audit event for a stale version, for a name that is already the workspace's and for a workspace that cannot be reached", async () => {
    for (const result of [{ kind: "stale", version: 5 }, { kind: "unchanged", version: 1 }, { kind: "unavailable" }] as const) {
      const { dependencies, audits } = world({ rename: result });

      expect(await renameWorkspace(dependencies, RENAME)).toEqual(result);
      expect(audits).toEqual([]);
    }
  });

  it("rejects when the audit event cannot be written, so the caller's transaction does not commit", async () => {
    const { dependencies } = world({ auditFails: true });

    await expect(renameWorkspace(dependencies, RENAME)).rejects.toThrow("the database refused");
  });

  it("refuses a name of no characters or more than 64 before it asks the store", async () => {
    const { dependencies, renames } = world();

    for (const name of ["", "x".repeat(65)]) {
      await expect(renameWorkspace(dependencies, { ...RENAME, name })).rejects.toThrow(RangeError);
    }
    expect(renames).toEqual([]);
    await expect(renameWorkspace(dependencies, { ...RENAME, name: "😀".repeat(64), expectedVersions: undefined })).resolves.toMatchObject({ kind: "renamed" });
  });
});

describe("changeWorkspaceSettings", () => {
  it("writes workspace.settings_changed with the setting and its old and new value when a value changes", async () => {
    const { dependencies, patches, audits, log } = world({ settings: { aiEnabled: true } });

    const outcome = await changeWorkspaceSettings(dependencies, { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: null, patch: { aiEnabled: false } });

    expect(outcome).toEqual({ kind: "changed", settings: { aiEnabled: false } });
    expect(patches).toEqual([{ aiEnabled: false }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      action: "workspace.settings_changed",
      entityType: "workspace",
      entityId: WORKSPACE,
      metadata: { setting: "aiEnabled", from: "true", to: "false" },
      ipPrefix: null,
    });
    expect(log).toEqual(["settings", "audit"]);
  });

  it("writes no event for a patch that leaves every value as it was, an empty patch included", async () => {
    for (const patch of [{ aiEnabled: true }, {}]) {
      const { dependencies, audits } = world({ settings: { aiEnabled: true } });

      const outcome = await changeWorkspaceSettings(dependencies, { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: null, patch });

      expect(outcome).toEqual({ kind: "unchanged", settings: { aiEnabled: true } });
      expect(audits).toEqual([]);
    }
  });

  it("answers unavailable and writes nothing when the workspace has no settings", async () => {
    const { dependencies, audits } = world({ settings: null });

    expect(await changeWorkspaceSettings(dependencies, { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: null, patch: { aiEnabled: false } })).toEqual({
      kind: "unavailable",
    });
    expect(audits).toEqual([]);
  });

  it("rejects when the audit event cannot be written, so the caller's transaction does not commit", async () => {
    const { dependencies } = world({ auditFails: true });

    await expect(changeWorkspaceSettings(dependencies, { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: null, patch: { aiEnabled: false } })).rejects.toThrow(
      "the database refused",
    );
  });
});
