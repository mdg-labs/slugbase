import type { EntitlementSource } from "../ports/entitlements.ts";
import {
  ACCOUNT_LIMIT_ENTITLEMENTS,
  ENTITLEMENT_CATALOG,
  FLAG_ENTITLEMENTS,
  WORKSPACE_LIMIT_ENTITLEMENTS,
  isEntitlementKey,
  type AccountEntitlementValues,
  type EntitlementLimit,
  type WorkspaceEntitlementValues,
} from "./catalog.ts";

// The evaluation of doc 01 sections 7.5 and 8.3. `EntitlementService.forRequest()` returns the entitlements of
// one request: the set of a workspace is memoised for the request, and cached for the process under
// `(workspace_id, entitlement_version)`, the version read from the workspace's row on every request. Any change
// to plan, archive state or an override increments that version in the same transaction as the change (see
// `withEntitlementChange`), so a cached set is never served after the source's answer changed: there is no
// lifetime to wait out. The version is read before the source is asked, so the answer stored under a version is
// at least as new as the change that made it. The account-scoped keys never enter the cache: they are asked of
// the source for the acting account within the request that needs them.

/** Thrown when a source answers outside the catalog (a missing key, a flag that is not a boolean, a limit that is not a count). */
export class EntitlementSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementSourceError";
  }
}

/** Reads `workspaces.entitlement_version`. */
export interface EntitlementVersions {
  /**
   * The version of the workspace for `accountId`; undefined when it cannot be read (the workspace does not exist,
   * is being deleted, or the account is no member of it), so no set is served for it.
   */
  read(request: { readonly accountId: string; readonly workspaceId: string }): Promise<number | undefined>;
}

/** The immutable entitlements of one workspace at one version. */
export interface EntitlementSet {
  readonly workspaceId: string;
  /** The `entitlement_version` the set was read at. */
  readonly version: number;
  readonly values: WorkspaceEntitlementValues;
  readonly upgradeAvailable: boolean;
}

/** The immutable entitlements of a workspace read for an account that is not a member of it yet. */
export interface JoiningEntitlements {
  readonly values: WorkspaceEntitlementValues;
  readonly upgradeAvailable: boolean;
}

/** The immutable account-scoped entitlements of one account. */
export interface AccountEntitlementSet {
  readonly accountId: string;
  readonly values: AccountEntitlementValues;
}

export interface RequestEntitlements {
  /** The set of a workspace; undefined when the workspace cannot be seen. Asked twice in one request, it is read once. */
  forWorkspace(workspaceId: string): Promise<EntitlementSet | undefined>;
  /**
   * The values of a workspace the acting account is about to join through an invitation. The version row is readable
   * to members only, so this answer is neither keyed by the version nor kept in the process cache: the source is asked
   * once per request, and what it answers is checked against the catalog like any other.
   */
  forJoiningWorkspace(workspaceId: string): Promise<JoiningEntitlements>;
  /** The account-scoped values of the acting account, read from the source on every request that needs them. */
  forAccount(): Promise<AccountEntitlementSet>;
}

export interface EntitlementService {
  /** The entitlements of one request: the same `request` object always returns the same memo, and no other request shares it. */
  forRequest(request: object, accountId: string): RequestEntitlements;
}

export interface EntitlementServiceOptions {
  readonly source: EntitlementSource;
  readonly versions: EntitlementVersions;
  /** How many workspaces the process cache holds before the oldest entry is dropped; by default 10 000. */
  readonly cacheSize?: number;
}

const DEFAULT_CACHE_SIZE = 10_000;

function isLimit(value: unknown): value is EntitlementLimit {
  return value === "unlimited" || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : typeof value === "number" ? String(value) : typeof value;
}

/** The workspace values of a source answer, checked against the catalog and frozen; only catalog keys are read. */
export function parseWorkspaceEntitlements(answer: unknown): WorkspaceEntitlementValues {
  if (typeof answer !== "object" || answer === null) {
    throw new EntitlementSourceError("the entitlement source answered no values for the workspace");
  }
  const parsed: Record<string, boolean | EntitlementLimit> = {};
  for (const key of FLAG_ENTITLEMENTS) {
    const value: unknown = Reflect.get(answer, key);
    if (typeof value !== "boolean") {
      throw new EntitlementSourceError(`the entitlement source answered ${shown(value)} for the flag ${key}`);
    }
    parsed[key] = value;
  }
  for (const key of WORKSPACE_LIMIT_ENTITLEMENTS) {
    const value: unknown = Reflect.get(answer, key);
    if (!isLimit(value)) {
      throw new EntitlementSourceError(`the entitlement source answered ${shown(value)} for the limit ${key}`);
    }
    parsed[key] = value;
  }
  return Object.freeze(parsed) as WorkspaceEntitlementValues;
}

/** The account values of a source answer, checked against the catalog and frozen. */
export function parseAccountEntitlements(answer: unknown): AccountEntitlementValues {
  if (typeof answer !== "object" || answer === null) {
    throw new EntitlementSourceError("the entitlement source answered no values for the account");
  }
  const parsed: Record<string, EntitlementLimit> = {};
  for (const key of ACCOUNT_LIMIT_ENTITLEMENTS) {
    const value: unknown = Reflect.get(answer, key);
    if (!isLimit(value)) {
      throw new EntitlementSourceError(`the entitlement source answered ${shown(value)} for the limit ${key}`);
    }
    parsed[key] = value;
  }
  return Object.freeze(parsed) as AccountEntitlementValues;
}

interface CacheEntry {
  readonly version: number;
  readonly set: EntitlementSet;
}

export function createEntitlementService({ source, versions, cacheSize = DEFAULT_CACHE_SIZE }: EntitlementServiceOptions): EntitlementService {
  // One entry per workspace, replaced when its version moves: the key is `(workspace_id, entitlement_version)`.
  const cache = new Map<string, CacheEntry>();
  const requests = new WeakMap<object, RequestEntitlements>();

  async function readSource(workspaceId: string): Promise<JoiningEntitlements> {
    const grant = await source.forWorkspace(workspaceId);
    if (typeof grant.upgradeAvailable !== "boolean") {
      throw new EntitlementSourceError("the entitlement source did not say whether an upgrade path exists");
    }
    return Object.freeze({ values: parseWorkspaceEntitlements(grant.values), upgradeAvailable: grant.upgradeAvailable });
  }

  async function load(accountId: string, workspaceId: string): Promise<EntitlementSet | undefined> {
    const version = await versions.read({ accountId, workspaceId });
    if (version === undefined) {
      cache.delete(workspaceId);
      return undefined;
    }
    const cached = cache.get(workspaceId);
    if (cached?.version === version) {
      return cached.set;
    }
    const { values, upgradeAvailable } = await readSource(workspaceId);
    const set: EntitlementSet = Object.freeze({ workspaceId, version, values, upgradeAvailable });
    // A slower request that read an older version must not replace the entry of a newer one.
    if ((cache.get(workspaceId)?.version ?? version) <= version) {
      cache.delete(workspaceId);
      cache.set(workspaceId, { version, set });
    }
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) {
        cache.delete(oldest.value);
      }
    }
    return set;
  }

  return {
    forRequest(request, accountId) {
      const known = requests.get(request);
      if (known !== undefined) {
        return known;
      }
      const sets = new Map<string, Promise<EntitlementSet | undefined>>();
      const joining = new Map<string, Promise<JoiningEntitlements>>();
      let account: Promise<AccountEntitlementSet> | undefined;
      const scope: RequestEntitlements = {
        forWorkspace(workspaceId) {
          const memo = sets.get(workspaceId) ?? load(accountId, workspaceId);
          sets.set(workspaceId, memo);
          memo.catch(() => {
            // A failed read is not memoised: the next ask in the request reads again.
            if (sets.get(workspaceId) === memo) {
              sets.delete(workspaceId);
            }
          });
          return memo;
        },
        forJoiningWorkspace(workspaceId) {
          const memo = joining.get(workspaceId) ?? readSource(workspaceId);
          joining.set(workspaceId, memo);
          memo.catch(() => {
            if (joining.get(workspaceId) === memo) {
              joining.delete(workspaceId);
            }
          });
          return memo;
        },
        forAccount() {
          account ??= source.forAccount(accountId).then((values) => Object.freeze({ accountId, values: parseAccountEntitlements(values) }));
          return account;
        },
      };
      requests.set(request, scope);
      return scope;
    },
  };
}

/** Who an entitlement is evaluated for. */
export interface EntitlementSubject {
  readonly accountId: string;
  readonly workspaceId?: string;
  /**
   * The account is not a member of `workspaceId` yet and is joining it through an invitation, so the workspace is
   * read from the source as it is now rather than through the version the row shows to members.
   */
  readonly joining?: boolean;
}

/**
 * Whether the subject holds an entitlement of the catalog: what stage 9 of the chain asks for an operation that
 * declares one. `request` identifies the request, so that what is read for it is read once.
 */
export type EntitlementCheck = (entitlement: string, subject: EntitlementSubject, request: object) => boolean | Promise<boolean>;

/**
 * The check over the service. A flag is held when it is on, a limit when it is not zero (how much of a limit
 * is used is counted where the operation enforces it). A key outside the catalog, a workspace key asked without
 * a workspace and a workspace that cannot be seen are never held. A failing source rejects: the request is
 * refused with an error, never granted.
 */
export function createEntitlementCheck(service: EntitlementService): EntitlementCheck {
  return async (entitlement, subject, request) => {
    if (!isEntitlementKey(entitlement)) {
      return false;
    }
    const entitlements = service.forRequest(request, subject.accountId);
    if (ENTITLEMENT_CATALOG[entitlement].scope === "account") {
      return isHeld(Reflect.get((await entitlements.forAccount()).values, entitlement));
    }
    if (subject.workspaceId === undefined) {
      return false;
    }
    const set = await workspaceSet(entitlements, subject.workspaceId, subject.joining === true);
    return set !== undefined && isHeld(Reflect.get(set.values, entitlement));
  };
}

function workspaceSet(entitlements: RequestEntitlements, workspaceId: string, joining: boolean): Promise<JoiningEntitlements | undefined> {
  return joining ? entitlements.forJoiningWorkspace(workspaceId) : entitlements.forWorkspace(workspaceId);
}

/**
 * Whether the plan behind the subject's workspace has a better one to offer: what an `entitlement_required` answer
 * reports beside the entitlement. A key outside the catalog, an account-scoped key, a workspace key asked without
 * a workspace and a workspace that cannot be seen have none. A failing source rejects.
 */
export type EntitlementUpgradeCheck = (entitlement: string, subject: EntitlementSubject, request: object) => boolean | Promise<boolean>;

export function createEntitlementUpgradeCheck(service: EntitlementService): EntitlementUpgradeCheck {
  return async (entitlement, subject, request) => {
    if (!isEntitlementKey(entitlement) || ENTITLEMENT_CATALOG[entitlement].scope === "account" || subject.workspaceId === undefined) {
      return false;
    }
    const set = await workspaceSet(service.forRequest(request, subject.accountId), subject.workspaceId, subject.joining === true);
    return set?.upgradeAvailable ?? false;
  };
}

/**
 * What creating a workspace asks of the account-scoped entitlement `workspaces.ownMax` (doc 01 section 7.5, doc 10
 * T11): the ceiling itself, which a flag check cannot say, and whether a better plan exists for the account's
 * workspaces. A failing source rejects, so a creation is refused with an error and never granted without a ceiling.
 */
export interface OwnedWorkspaceEntitlements {
  /** The account's `workspaces.ownMax`, asked of the source for the acting account on every request that needs it. */
  limit(accountId: string, request: object): Promise<EntitlementLimit>;
  /**
   * Whether the plan behind any of the workspaces the account owns has a better one to offer. False for an account
   * that owns none and for a workspace that cannot be seen.
   */
  upgradeAvailable(accountId: string, ownedWorkspaceIds: readonly string[], request: object): Promise<boolean>;
}

export function createOwnedWorkspaceEntitlements(service: EntitlementService): OwnedWorkspaceEntitlements {
  return {
    async limit(accountId, request) {
      return (await service.forRequest(request, accountId).forAccount()).values["workspaces.ownMax"];
    },
    async upgradeAvailable(accountId, ownedWorkspaceIds, request) {
      const entitlements = service.forRequest(request, accountId);
      for (const workspaceId of ownedWorkspaceIds) {
        if ((await entitlements.forWorkspace(workspaceId))?.upgradeAvailable === true) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * What accepting an invitation asks of the workspace-scoped entitlement `seats.max` (doc 01 sections 7.5 and 13.1,
 * doc 10 T11): the ceiling on the members, read for a workspace the acting account is about to join. A failing source
 * rejects, so an acceptance is refused with an error and never granted without a ceiling.
 */
export interface SeatEntitlements {
  /**
   * The workspace's `seats.max` as the count of members it may hold, `null` for no ceiling. The workspace is read from
   * the source as it is now, since the account is no member yet and cannot read the version of the row.
   */
  limit(accountId: string, workspaceId: string, request: object): Promise<number | null>;
}

export function createSeatEntitlements(service: EntitlementService): SeatEntitlements {
  return {
    async limit(accountId, workspaceId, request) {
      const limit = (await service.forRequest(request, accountId).forJoiningWorkspace(workspaceId)).values["seats.max"];
      return limit === "unlimited" ? null : limit;
    },
  };
}

/**
 * What creating a bookmark asks of the workspace-scoped entitlement `bookmarks.max` (doc 01 section 7.5, doc 10 T11): the
 * ceiling itself, which a flag check cannot say. The count it is compared with is `workspaces.bookmark_count`, taken under
 * the workspace's row lock in the transaction that inserts the bookmark; this reads only the ceiling, before that
 * transaction opens, so no call to the entitlement source is made while the lock is held.
 */
export interface BookmarkEntitlements {
  /**
   * The workspace's `bookmarks.max` for a member of it; undefined when the workspace cannot be seen (it does not exist, is
   * being deleted or the account is no member). A failing source rejects, so a creation is refused with an error and never
   * granted without a ceiling.
   */
  limit(accountId: string, workspaceId: string, request: object): Promise<EntitlementLimit | undefined>;
}

export function createBookmarkEntitlements(service: EntitlementService): BookmarkEntitlements {
  return {
    async limit(accountId, workspaceId, request) {
      return (await service.forRequest(request, accountId).forWorkspace(workspaceId))?.values["bookmarks.max"];
    },
  };
}

function isHeld(value: unknown): boolean {
  return value === true || value === "unlimited" || (typeof value === "number" && value > 0);
}

/** Thrown to say a version could not be raised; the change it belongs to is then not made. */
export class EntitlementVersionError extends Error {
  constructor() {
    super("the entitlement version of the workspace could not be raised");
    this.name = "EntitlementVersionError";
  }
}

/** Raises `workspaces.entitlement_version` of the workspace of the open transaction. */
export interface EntitlementVersionWriter {
  /** The new version; undefined when the workspace of the transaction cannot be changed (it is not the one it acts in, or is being deleted). */
  bump(): Promise<number | undefined>;
}

/**
 * Every change to a workspace's plan, archive state or an override goes through here (doc 01 section 7.5): the
 * version is raised in the transaction that makes the change, so the per-process cache never serves what the
 * change replaced, and a caller cannot make the change and forget the version. `change` runs first; a version
 * that cannot be raised throws, and the transaction that holds both rolls the change back.
 */
export async function withEntitlementChange<T>(writer: EntitlementVersionWriter, change: () => Promise<T>): Promise<T> {
  const result = await change();
  if ((await writer.bump()) === undefined) {
    throw new EntitlementVersionError();
  }
  return result;
}
