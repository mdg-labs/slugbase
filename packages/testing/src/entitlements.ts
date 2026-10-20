import {
  ENTITLEMENT_CATALOG,
  type AccountEntitlementValues,
  type EntitlementKey,
  type EntitlementLimit,
  type EntitlementSource,
  type EntitlementVersions,
  type WorkspaceEntitlementGrant,
  type WorkspaceEntitlementValues,
} from "@slugbase/core";

/** A value a test grants: a flag is on or off, a limit is a count or `unlimited`. */
export type GrantedValue = boolean | EntitlementLimit;

/**
 * An entitlement source a test steers (doc 08 section 3.1): it starts as the full, unlimited source of the
 * Community Edition, `grant` and `deny` change any key of the catalog, and `version` moves with every change
 * the way `workspaces.entitlement_version` moves when a plan, an archive state or an override changes. The
 * double is also an `EntitlementVersions` reader, so a unit test can hand it to the engine as both halves; a
 * test against a database writes the version to the row itself and reads this one only to compare. A change
 * applies to every workspace and every account.
 */
export class LimitedEntitlementSource implements EntitlementSource, EntitlementVersions {
  readonly available = true;
  #version = 1;
  #upgradeAvailable = false;
  readonly #workspace: Record<string, GrantedValue> = {
    "bookmarks.max": "unlimited",
    "seats.max": "unlimited",
    "ai.suggestions": true,
    "sharing.members": true,
    "sharing.teams": true,
    "members.invite": true,
    "teams.manage": true,
    "audit.log": true,
  };
  readonly #account: Record<string, EntitlementLimit> = { "workspaces.ownMax": "unlimited" };
  readonly #reads = { workspaces: [] as string[], accounts: [] as string[] };

  /** The version a change last moved to; starts at 1, as a new workspace's does. */
  get version(): number {
    return this.#version;
  }

  /** The workspaces and accounts the engine asked this source for, in order. */
  get reads(): { readonly workspaces: readonly string[]; readonly accounts: readonly string[] } {
    return { workspaces: [...this.#reads.workspaces], accounts: [...this.#reads.accounts] };
  }

  /** Sets a key: `true`, `false`, a count or `"unlimited"` (a flag takes a boolean, a limit a count or `"unlimited"`). Moves the version. */
  grant(key: EntitlementKey, value: GrantedValue): this {
    const { scope, type } = ENTITLEMENT_CATALOG[key];
    if (type === "flag" ? typeof value !== "boolean" : typeof value === "boolean") {
      throw new Error(`${key} is a ${type} and cannot be set to ${String(value)}`);
    }
    if (scope === "account") {
      this.#account[key] = value as EntitlementLimit;
    } else {
      this.#workspace[key] = value;
    }
    return this.bump();
  }

  /** Withholds a key: a flag is turned off and a limit set to zero. Moves the version. */
  deny(key: EntitlementKey): this {
    return this.grant(key, ENTITLEMENT_CATALOG[key].type === "flag" ? false : 0);
  }

  /** Says whether the plan behind the workspaces has a better one to offer. Moves the version. */
  offerUpgrade(available: boolean): this {
    this.#upgradeAvailable = available;
    return this.bump();
  }

  /** Moves the version without changing a value, as a change that happened to leave the answer as it was does. */
  bump(): this {
    this.#version += 1;
    return this;
  }

  forWorkspace(workspaceId: string): Promise<WorkspaceEntitlementGrant> {
    this.#reads.workspaces.push(workspaceId);
    return Promise.resolve({ values: { ...this.#workspace } as unknown as WorkspaceEntitlementValues, upgradeAvailable: this.#upgradeAvailable });
  }

  forAccount(accountId: string): Promise<AccountEntitlementValues> {
    this.#reads.accounts.push(accountId);
    return Promise.resolve({ ...this.#account } as unknown as AccountEntitlementValues);
  }

  read(): Promise<number> {
    return Promise.resolve(this.#version);
  }
}
