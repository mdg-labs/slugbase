import { prepareAuditRecord, type AuditRecord } from "../audit/writer.ts";
import { hashCredentialToken } from "../auth/credential-tokens.ts";
import type { DomainEvent } from "../events/catalog.ts";
import type { WorkspaceRole } from "../ports/tenant-resolver.ts";

// Accepting an invitation with registration fields: the invited address has no account, and the token that reached
// its mailbox is the proof of the address (doc 02 section 2.2, Q31, doc 04 section 10.5, doc 10 T8 and T19). The
// account takes the address the invitation names, never one the request names, so a link forwarded to another
// person creates an account for the invited address or none. The account is verified at once, whatever
// `EMAIL_VERIFICATION_REQUIRED` says; it gets no personal workspace, since the workspace it joins is where it works.
//
// The database operation behind it creates the account, adds the membership with exactly the invited role, marks the
// invitation accepted and signs the account in with a full session acting in the workspace, in one transaction with
// the audit event and the domain events this service prepares for it, so each exists exactly when the others do. The
// checks run in a fixed order and a refusal writes nothing, so the invitation stays pending and usable: a token that
// is no longer a pending invitation's, then no seat left, then an address that already has an account.

/** The session the new account is signed in with. */
export interface InvitationSignupSession {
  /** A fresh UUIDv7. */
  readonly id: string;
  /** SHA-256 of the 32-byte session token. */
  readonly tokenHash: Buffer;
  /** SHA-256 of the token of the session cookie the request carried, which that session is replaced by; null when it carried none. */
  readonly replacedTokenHash: Buffer | null;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
  /** Truncated by the database. */
  readonly userAgent: string | null;
}

/** What the database operation answered. */
export type InvitationSignupResult =
  | { readonly kind: "accepted"; readonly workspaceId: string; readonly invitationId: string; readonly role: WorkspaceRole }
  /** An unknown, used, revoked, replaced or expired token, or a workspace being deleted. */
  | { readonly kind: "gone" }
  | { readonly kind: "seat_limit_reached" }
  /** An account holds the invited address, or the address is reserved. */
  | { readonly kind: "email_taken" };

export type InvitationSignupEvent = DomainEvent<"account.created"> | DomainEvent<"member.joined">;

/** What is written in the transaction of the acceptance, once the invitation names its workspace and role. */
export interface InvitationSignupRecords {
  readonly audit: readonly AuditRecord[];
  readonly events: readonly InvitationSignupEvent[];
}

export interface NewAccountAcceptance {
  readonly tokenHash: Buffer;
  /** A fresh UUIDv7. */
  readonly accountId: string;
  readonly displayName: string;
  /** An argon2id PHC string. */
  readonly passwordHash: string;
  readonly locale: string;
  /** The seats the workspace may hold; null for no limit. */
  readonly seatLimit: number | null;
  readonly session: InvitationSignupSession;
  /** Called inside the transaction once the invitation is accepted; what it returns is written in that transaction. */
  readonly onAccepted: (accepted: { readonly workspaceId: string; readonly role: WorkspaceRole }) => InvitationSignupRecords;
}

export interface InvitationSignupStore {
  /**
   * Creates the verified account of the invitation the token hash belongs to, adds it to the invitation's
   * workspace with the invited role, accepts the invitation and signs the account in, in one transaction with the
   * records `onAccepted` returns. A refusal writes nothing; a failure of any write rejects and leaves nothing.
   */
  acceptWithNewAccount(acceptance: NewAccountAcceptance): Promise<InvitationSignupResult>;
}

export interface InvitationSignupDependencies {
  readonly store: InvitationSignupStore;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface InvitationSignupAsk {
  /** The token the link carries. */
  readonly token: string;
  readonly displayName: string;
  /** An argon2id PHC string of the password the policy accepted. */
  readonly passwordHash: string;
  readonly locale: string;
  readonly seatLimit: number | null;
  readonly session: InvitationSignupSession;
}

/**
 * Creates the account of the invitation behind the token and accepts the invitation as it, recording `account.created`
 * (path `invitation`) and `member.joined` as domain events and `member.joined` as an audit event in the same
 * transaction. Reads nothing for a text that cannot be a token.
 */
export async function acceptInvitationWithAccount({ store, newId }: InvitationSignupDependencies, ask: InvitationSignupAsk): Promise<InvitationSignupResult> {
  const tokenHash = hashCredentialToken(ask.token);
  if (tokenHash === undefined) {
    return { kind: "gone" };
  }
  const accountId = newId();
  return store.acceptWithNewAccount({
    tokenHash,
    accountId,
    displayName: ask.displayName,
    passwordHash: ask.passwordHash,
    locale: ask.locale,
    seatLimit: ask.seatLimit,
    session: ask.session,
    onAccepted: ({ workspaceId, role }) => ({
      audit: [
        prepareAuditRecord(
          {
            action: "member.joined",
            workspaceId,
            actor: { type: "account", accountId, label: ask.displayName },
            entity: { type: "member", id: accountId },
            metadata: { role },
            ipPrefix: ask.session.ipPrefix,
          },
          newId,
        ),
      ],
      events: [
        { eventId: newId(), name: "account.created", payload: { accountId, path: "invitation" } },
        { eventId: newId(), name: "member.joined", payload: { workspaceId, accountId, role } },
      ],
    }),
  });
}
