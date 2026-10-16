import type { HookDispatcher, RegistrationPolicyInput } from "../hooks/index.ts";
import { ProblemError } from "../http/problem.ts";

// The one gate every account-creation path except first-run setup passes before it checks
// whether the email is taken, hashes a password for the account or writes anything (doc 01
// section 13.5, doc 02 section 1 principle 3): self-registration, accepting an invitation with
// registration fields, and OIDC auto-create. The policy sees the email and the path only, so a
// refusal says nothing about whether an account exists, and every refusal is the same answer
// whichever module refused and whatever reason it gave.

const REFUSED = "Registration is not available for this request.";

/**
 * Consults the registration policy of the composed modules with the address and the path. Allows by
 * returning; a refusal throws `403 registration_refused` with one fixed detail. A hook that throws,
 * times out or answers out of contract makes the dispatcher throw `503 unavailable`, which this passes on.
 */
export async function assertRegistrationAllowed(hooks: HookDispatcher, input: RegistrationPolicyInput): Promise<void> {
  const result = await hooks.registrationPolicy({ email: input.email, path: input.path });
  if (result.outcome === "refuse") {
    throw new ProblemError("registration_refused", REFUSED);
  }
}
