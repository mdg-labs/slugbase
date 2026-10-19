import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import { WORKSPACE_NAME_MAX_LENGTH } from "./create.ts";

// Renaming a workspace and changing its settings (doc 02 sections 3.1 and 10, doc 04 section 2.4 and
// 10.4, doc 05 section 2.2). The store behind the port reaches the rows in the transaction of the request
// and locks them for the length of it, so the "before" the audit event records is the value the change
// replaced. The service decides whether anything changed, what is recorded and what is refused; a change
// that did not happen writes no audit event, and a failure of the audit write rejects, so the caller's
// transaction must not commit.

/** The settings of a workspace (doc 05 section 2.2); a new setting is a new field here and in the store. */
export interface WorkspaceSettings {
  readonly aiEnabled: boolean;
}

/** The fields of a settings change; a field that is absent is left as it is. */
export type WorkspaceSettingsPatch = { readonly [Key in keyof WorkspaceSettings]?: WorkspaceSettings[Key] };

export interface WorkspaceSettingsChange {
  /** The settings the change started from, read under the row lock. */
  readonly previous: WorkspaceSettings;
  /** The settings after it. */
  readonly current: WorkspaceSettings;
}

export interface WorkspaceRenameRequest {
  readonly name: string;
  /**
   * The versions the caller accepts (`If-Match`); the rename is refused as stale when the workspace is at
   * none of them. Undefined when the caller sent no precondition.
   */
  readonly expectedVersions: readonly number[] | undefined;
}

export type WorkspaceRenameResult =
  /** The name was replaced and the version moved to `version`. */
  | { readonly kind: "renamed"; readonly previousName: string; readonly version: number }
  /** The name is the one the workspace has; nothing was written and the version is `version`. */
  | { readonly kind: "unchanged"; readonly version: number }
  /** The workspace is at `version`, which the caller did not accept; nothing was written. */
  | { readonly kind: "stale"; readonly version: number }
  /** The workspace of the transaction cannot be reached. */
  | { readonly kind: "unavailable" };

export interface WorkspaceAdministrationStore {
  /** Renames the workspace of the transaction, comparing the version under the row lock. */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceRenameResult>;
  /**
   * Applies the patch to the settings of the workspace of the transaction and says what they were and are;
   * a patch that changes nothing writes nothing. Undefined when the workspace has no settings row.
   */
  changeSettings(patch: WorkspaceSettingsPatch): Promise<WorkspaceSettingsChange | undefined>;
}

export interface WorkspaceAdministrationDependencies {
  readonly store: WorkspaceAdministrationStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
}

export interface WorkspaceChangeAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export interface WorkspaceRenameAsk extends WorkspaceChangeAsk {
  readonly name: string;
  readonly expectedVersions: readonly number[] | undefined;
}

export type WorkspaceRenameOutcome = Exclude<WorkspaceRenameResult, { readonly kind: "renamed" }> | { readonly kind: "renamed"; readonly version: number };

/**
 * Renames the workspace and writes `workspace.renamed` with the old and the new name, both in the
 * transaction the stores are bound to. A stale precondition and an unchanged name write nothing.
 */
export async function renameWorkspace({ store, audit }: WorkspaceAdministrationDependencies, ask: WorkspaceRenameAsk): Promise<WorkspaceRenameOutcome> {
  const length = Array.from(ask.name).length;
  if (length < 1 || length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new RangeError(`a workspace name has 1 to ${String(WORKSPACE_NAME_MAX_LENGTH)} characters`);
  }
  const result = await store.rename({ name: ask.name, expectedVersions: ask.expectedVersions });
  if (result.kind !== "renamed") {
    return result;
  }
  await audit.write({
    action: "workspace.renamed",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "workspace", id: ask.workspaceId },
    metadata: { from: result.previousName, to: ask.name },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "renamed", version: result.version };
}

export interface WorkspaceSettingsAsk extends WorkspaceChangeAsk {
  readonly patch: WorkspaceSettingsPatch;
}

export type WorkspaceSettingsOutcome =
  | { readonly kind: "changed"; readonly settings: WorkspaceSettings }
  | { readonly kind: "unchanged"; readonly settings: WorkspaceSettings }
  /** The workspace has no settings row. */
  | { readonly kind: "unavailable" };

const SETTING_NAMES = ["aiEnabled"] as const satisfies readonly (keyof WorkspaceSettings)[];

/**
 * Applies the patch and writes one `workspace.settings_changed` event for each setting whose value it
 * changed, in the transaction the stores are bound to. A patch that leaves every value as it was writes
 * nothing.
 */
export async function changeWorkspaceSettings(
  { store, audit }: WorkspaceAdministrationDependencies,
  ask: WorkspaceSettingsAsk,
): Promise<WorkspaceSettingsOutcome> {
  const change = await store.changeSettings(ask.patch);
  if (change === undefined) {
    return { kind: "unavailable" };
  }
  let changed = false;
  for (const setting of SETTING_NAMES) {
    if (change.previous[setting] === change.current[setting]) {
      continue;
    }
    changed = true;
    await audit.write({
      action: "workspace.settings_changed",
      workspaceId: ask.workspaceId,
      actor: ask.actor,
      entity: { type: "workspace", id: ask.workspaceId },
      metadata: { setting, from: String(change.previous[setting]), to: String(change.current[setting]) },
      ipPrefix: ask.ipPrefix,
    });
  }
  return { kind: changed ? "changed" : "unchanged", settings: change.current };
}
