/** The result of a hook that can refuse (doc 01 section 13): allow, or refuse with a code. */
export type HookResult<Code extends string = string> =
  | { readonly outcome: "allow" }
  | { readonly outcome: "refuse"; readonly code: Code };

const ALLOW: HookResult<never> = Object.freeze({ outcome: "allow" });

/** Builds the results a hook answers with; a hook never refuses by throwing. */
export const HookResult = {
  allow(): HookResult<never> {
    return ALLOW;
  },
  refuse<const Code extends string>(code: Code): HookResult<Code> {
    return Object.freeze({ outcome: "refuse", code });
  },
} as const;

/** The refusal codes of the deletion guard; a refusal with any other code is a hook failure. */
export const DELETION_REFUSAL_CODES = ["billing_active"] as const;
export type DeletionRefusalCode = (typeof DELETION_REFUSAL_CODES)[number];

/** Every refusal reason of the registration policy answers with this one code (doc 04 section 3). */
export const REGISTRATION_REFUSAL_CODE = "registration_refused" as const;
export type RegistrationRefusalCode = typeof REGISTRATION_REFUSAL_CODE;

export interface SeatCheckInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly invitationId: string;
}

export interface SeatCheckAnswer {
  /** The workspace's seat limit; `null` means unlimited. */
  readonly seatLimit: number | null;
}

export type DeletionGuardInput =
  | {
      readonly kind: "workspace";
      readonly workspaceId: string;
      readonly accountId: string;
      readonly requestedBy: "member" | "instanceAdmin";
    }
  | {
      readonly kind: "account";
      readonly accountId: string;
      readonly requestedBy: "member" | "instanceAdmin";
    };

/** How the account is about to be created (doc 01 section 13.5). */
export type RegistrationPath = "self-registration" | "invitation" | "oidc";

export interface RegistrationPolicyInput {
  readonly email: string;
  readonly path: RegistrationPath;
}

/**
 * The hooks a module registers (doc 01 section 13). Each receives plain values
 * and identifiers, never a database handle, and runs after authentication,
 * tenant resolution and authorization.
 */
export interface ServerHooks {
  /** Runs when an invitation is accepted; the lowest limit across modules wins. */
  readonly seatCheck?: (input: SeatCheckInput) => SeatCheckAnswer | Promise<SeatCheckAnswer>;
  /** Runs before a workspace or an account is deleted; the first refusal wins. */
  readonly deletionGuard?: (input: DeletionGuardInput) => HookResult<DeletionRefusalCode> | Promise<HookResult<DeletionRefusalCode>>;
  /** Runs before an account is created; any refusal reason answers `registration_refused`. */
  readonly registrationPolicy?: (input: RegistrationPolicyInput) => HookResult | Promise<HookResult>;
}

export type HookName = keyof ServerHooks;

/**
 * The refusal codes a module declares for the hooks that can refuse with a
 * code from a closed list. A code outside that list fails composition; a hook
 * that answers with a code it did not declare fails closed.
 */
export interface HookRefusals {
  readonly deletionGuard?: readonly DeletionRefusalCode[];
}

export const HOOK_NAMES = ["seatCheck", "deletionGuard", "registrationPolicy"] as const satisfies readonly HookName[];
