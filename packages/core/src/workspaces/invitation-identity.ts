import { prepareAuditRecord, type AuditRecord } from "../audit/writer.ts";
import type { DomainEvent } from "../events/catalog.ts";
import type { WorkspaceRole } from "../ports/tenant-resolver.ts";
import type { InvitationSignupEvent, InvitationSignupSession } from "./invitation-signup.ts";

// Accepting an invitation through an OIDC provider (doc 02 sections 2.8 and 3.4, Q31, Q32, doc 04 section 4.5, doc 10
// T19 and T20). The caller has completed the handshake and holds the provider's assertion of an address as verified; the
// token it started with arrives as the hash the handshake record kept. The database operation behind it accepts only
// when that address is exactly the one the invitation names, and it decides which account accepts: the one the
// identity is linked to, else the enabled account that holds the invited address verified (the identity is linked to
// it), else a new verified account for the invited address, which the invitation authorises whatever the provider's
// auto-create setting says. That last case happens only when `mayCreate` says the registration policy allowed it.
// Linking the identity, creating the account, the membership, the accepted invitation and the session acting in the
// workspace are one transaction with the audit event and the domain events this service prepares for it, so each exists
// exactly when the others do, and a refusal writes nothing and leaves the invitation pending.

/** What the database operation answered. */
export type InvitationIdentityResult =
  | {
      readonly kind: "accepted";
      readonly workspaceId: string;
      readonly invitationId: string;
      readonly role: WorkspaceRole;
      /** The account that accepted. */
      readonly accountId: string;
      /** True when the acceptance created it. */
      readonly created: boolean;
    }
  /** An unknown, used, revoked, replaced or expired token, a workspace being deleted or an account that is disabled. */
  | { readonly kind: "gone" }
  /** The provider's address is not the invited one, or the account does not hold the invited address verified. */
  | { readonly kind: "email_mismatch" }
  | { readonly kind: "already_member" }
  | { readonly kind: "seat_limit_reached" }
  /** An account that was not verified, or is disabled, holds the invited address, or it is reserved. */
  | { readonly kind: "email_taken" }
  /** An account would have to be created and the registration policy did not allow it. */
  | { readonly kind: "not_permitted" }
  /** The identity is linked to another account. */
  | { readonly kind: "identity_in_use" };

/** What is written in the transaction of the acceptance, once the invitation names its workspace and role. */
export interface InvitationIdentityRecords {
  readonly audit: readonly AuditRecord[];
  readonly events: readonly InvitationSignupEvent[];
}

export interface IdentityAcceptance {
  readonly tokenHash: Buffer;
  /** The slug of the provider. */
  readonly provider: string;
  /** The `sub` the provider asserted. */
  readonly subject: string;
  /** The address the provider asserted as verified, trimmed and NFKC-normalised; the invitation must name exactly it. */
  readonly email: string;
  /** A fresh UUIDv7, for the identity row. */
  readonly identityId: string;
  /** A fresh UUIDv7, for the account when one is created. */
  readonly accountId: string;
  /** The display name of an account that is created. */
  readonly displayName: string;
  readonly locale: string;
  /** Whether an account may be created for the invited address. */
  readonly mayCreate: boolean;
  /** The seats the workspace may hold; null for no limit. */
  readonly seatLimit: number | null;
  readonly session: InvitationSignupSession;
  /**
   * Called inside the transaction once the invitation is accepted, with the account that accepted; what it returns is
   * written in that transaction.
   */
  readonly onAccepted: (accepted: {
    readonly workspaceId: string;
    readonly role: WorkspaceRole;
    readonly accountId: string;
    readonly displayName: string;
    readonly created: boolean;
  }) => InvitationIdentityRecords;
}

export interface InvitationIdentityStore {
  /**
   * Accepts the invitation the token hash belongs to for the account the provider's identity leads to, signs it in
   * and records what `onAccepted` returns, in one transaction. A refusal writes nothing; a failure of any write
   * rejects and leaves nothing.
   */
  acceptWithIdentity(acceptance: IdentityAcceptance): Promise<InvitationIdentityResult>;
}

export interface InvitationIdentityDependencies {
  readonly store: InvitationIdentityStore;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface InvitationIdentityAsk {
  readonly tokenHash: Buffer;
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  /** The display name an account that is created gets. */
  readonly displayName: string;
  readonly locale: string;
  readonly mayCreate: boolean;
  readonly seatLimit: number | null;
  readonly session: InvitationSignupSession;
}

/**
 * Accepts the invitation behind the token hash for the account the provider's identity leads to, recording
 * `member.joined` as an audit event and a domain event, and, when the acceptance created the account,
 * `account.created` (path `invitation`), in the same transaction.
 */
export function acceptInvitationWithIdentity({ store, newId }: InvitationIdentityDependencies, ask: InvitationIdentityAsk): Promise<InvitationIdentityResult> {
  return store.acceptWithIdentity({
    ...ask,
    identityId: newId(),
    accountId: newId(),
    onAccepted: ({ workspaceId, role, accountId, displayName, created }) => {
      const events: InvitationSignupEvent[] = [];
      if (created) {
        events.push({ eventId: newId(), name: "account.created", payload: { accountId, path: "invitation" } } satisfies DomainEvent<"account.created">);
      }
      events.push({ eventId: newId(), name: "member.joined", payload: { workspaceId, accountId, role } } satisfies DomainEvent<"member.joined">);
      return {
        audit: [
          prepareAuditRecord(
            {
              action: "member.joined",
              workspaceId,
              actor: { type: "account", accountId, label: displayName },
              entity: { type: "member", id: accountId },
              metadata: { role },
              ipPrefix: ask.session.ipPrefix,
            },
            newId,
          ),
        ],
        events,
      };
    },
  });
}
