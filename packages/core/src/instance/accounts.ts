import type { AccessModeChange, AccessModeOutcome, AccountAccessMode, ExportOnlyEndAction } from "../accounts/access-mode.ts";

// The account operations of the CE instance admin (doc 02 section 11.2, doc 04 section 10.10, doc 05 sections 3.3
// and 7.1, doc 10 T4 and T18): list every account without anything secret or any content, grant or clear the
// instance-admin flag, disable or enable an account, and mark its address verified. Each is a `sys_instance_*` system operation that checks the
// admin again in the database and writes its instance audit event in the same call, so this module decides what is
// asked and how an answer is read, and never writes an event itself.
//
// The export-only access mode (doc 02 section 2.11) is set and cleared by `setInstanceAccountAccessMode`, which asks the database for it in the same
// call that writes the audit event and, for a mode that is set, queues the email that tells the account.
//
// An account that is not an instance admin, and an instance admin who is disabled, are not counted as "another admin":
// the instance must keep an admin who can sign in. The database decides that under the transaction-level advisory lock
// that serialises every change to the set of admins (doc 05 section 7.1).

/** An account as the instance admin lists it: what is needed to find it and tell its state, and nothing secret. */
export interface InstanceAccount {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly isInstanceAdmin: boolean;
  readonly disabled: boolean;
  /** `disabled` while the account is disabled, `exportOnly` while it is in the export-only period, else `full`. */
  readonly accessMode: AccountAccessMode;
  /** The end of the export-only period; null unless `accessMode` is `exportOnly`. */
  readonly exportOnlyUntil: Date | null;
  /** What happens at the end of the period; null unless `accessMode` is `exportOnly`. */
  readonly exportOnlyEndAction: ExportOnlyEndAction | null;
  /** Null while the account never completed a sign-in. */
  readonly lastSignInAt: Date | null;
  /** The workspaces, not being deleted, the account is a member of. */
  readonly workspaceCount: number;
}

/** What a change of an account did. */
export type InstanceAccountUpdateOutcome =
  /** Every field the ask named is in the state it names; `adminChanged`, `disabledChanged` and `verifiedChanged` say which of them moved. */
  | {
      readonly kind: "updated";
      readonly account: InstanceAccount;
      readonly adminChanged: boolean;
      readonly disabledChanged: boolean;
      readonly verifiedChanged: boolean;
    }
  /** The account does not exist; nothing was written. */
  | { readonly kind: "unknown_account" }
  /** The change would leave the instance without an enabled instance admin; `field` is the one of the ask it refused. */
  | { readonly kind: "last_instance_admin"; readonly field: "isInstanceAdmin" | "disabled" }
  /** The change grants the admin flag to an account in the export-only access mode, which is never an instance admin; nothing was written. */
  | { readonly kind: "export_only" };

/** The fields of an account an instance admin changes; a field left out stays as it is. */
export interface InstanceAccountChange {
  readonly isInstanceAdmin?: boolean;
  readonly disabled?: boolean;
  /** Marks the address verified; nothing marks one unverified, so the only value is `true`. */
  readonly emailVerified?: true;
}

/** The stores of the instance admin's account operations, bound to the account-level transaction of the request. */
export interface InstanceAccountStore {
  /** Every account, oldest first, and the instance audit event `instance.accounts_viewed`. */
  listAccounts(eventId: string, ipPrefix: string | null): Promise<readonly InstanceAccount[]>;
  /**
   * Applies the change to the account in one call that checks the calling admin once: sets or clears the flag
   * (`instance.account_admin_granted` or `instance.account_admin_revoked`, under `adminEventId`) and disables or enables
   * the account (`instance.account_disabled` or `instance.account_enabled`, under `disabledEventId`) and marks the address
   * verified (`instance.account_email_verified`, under `verifiedEventId`). Marking an address that was not verified takes away
   * what its registrant set up, as redeeming the verification link does: the password, sessions, second factor, API tokens,
   * linked identities and the unused tokens of the account (the calling admin's own account is only marked). A change of the flag, and disabling, delete every session of the account. When `notify` is set and the account was disabled by this
   * call, the email that tells it so is queued in the same transaction. A field that already has the value changes
   * nothing, writes no event and queues nothing.
   */
  updateAccount(
    accountId: string,
    change: InstanceAccountChange,
    notify: boolean,
    eventIds: { readonly admin: string; readonly disabled: string; readonly verified: string },
    ipPrefix: string | null,
  ): Promise<InstanceAccountUpdateOutcome>;
}

export interface InstanceAccountAccessModeStore {
  /**
   * Sets or clears the export-only mode of the account through `sys_instance_set_account_access_mode`, which checks the calling
   * admin again, writes the instance audit event (`instance.account_export_only_set` or `instance.account_export_only_cleared`, under
   * `eventId`) in the same call, and, when `notify` is set and the answer is `set`, queues the email that tells the account in the same
   * transaction. Anything but `set` and `cleared` writes and queues nothing.
   */
  setAccessMode(accountId: string, change: AccessModeChange, notify: boolean, eventId: string, ipPrefix: string | null): Promise<AccessModeOutcome>;
}

export interface InstanceAccountDependencies {
  readonly store: InstanceAccountStore;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface InstanceAccountAsk {
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

/** The accounts of the instance. */
export function listInstanceAccounts({ store, newId }: InstanceAccountDependencies, ask: InstanceAccountAsk): Promise<readonly InstanceAccount[]> {
  return store.listAccounts(newId(), ask.ipPrefix);
}

export interface InstanceAccountUpdateAsk extends InstanceAccountAsk {
  readonly accountId: string;
  /** Grant (`true`) or clear (`false`) the flag; left out keeps it. */
  readonly isInstanceAdmin?: boolean;
  /** Disable (`true`) or enable (`false`); left out keeps the state. */
  readonly disabled?: boolean;
  /** Mark the address verified; left out keeps it. */
  readonly emailVerified?: true;
  /** Whether the email that tells a disabled account so can be queued, that is, whether mail is configured. */
  readonly notify: boolean;
}

/** Applies the flag, the disabled state and the verified address the ask names in one call of the store, which checks the admin once. */
export async function updateInstanceAccount(
  { store, newId }: InstanceAccountDependencies,
  ask: InstanceAccountUpdateAsk,
): Promise<InstanceAccountUpdateOutcome> {
  if (ask.isInstanceAdmin === undefined && ask.disabled === undefined && ask.emailVerified === undefined) {
    throw new RangeError("an account change names the flag, the disabled state or the verified address");
  }
  return store.updateAccount(
    ask.accountId,
    {
      ...(ask.isInstanceAdmin === undefined ? {} : { isInstanceAdmin: ask.isInstanceAdmin }),
      ...(ask.disabled === undefined ? {} : { disabled: ask.disabled }),
      ...(ask.emailVerified === undefined ? {} : { emailVerified: ask.emailVerified }),
    },
    ask.notify,
    { admin: newId(), disabled: newId(), verified: newId() },
    ask.ipPrefix,
  );
}

export interface InstanceAccessModeAsk extends InstanceAccountAsk {
  readonly accountId: string;
  readonly change: AccessModeChange;
  /** Whether the email that tells the account can be queued, that is, whether mail is configured. */
  readonly notify: boolean;
}

/**
 * Sets or clears the export-only mode of the account. The end date of a mode that is set is at least a day ahead, which the database
 * judges by its own clock; an admin account and a disabled account are refused.
 */
export function setInstanceAccountAccessMode(
  { store, newId }: { readonly store: InstanceAccountAccessModeStore; readonly newId: () => string },
  ask: InstanceAccessModeAsk,
): Promise<AccessModeOutcome> {
  return store.setAccessMode(ask.accountId, ask.change, ask.notify, newId(), ask.ipPrefix);
}
