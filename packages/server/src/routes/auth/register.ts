import { register } from "@slugbase/contracts";
import { normalizeEmail, registrationLocale, registrationUnavailable, type MailPort, type PasswordPolicy, type RegistrationSettings } from "@slugbase/core";
import type { RegistrationStore } from "@slugbase/db";
import { provisionWorkspaceIn } from "../../auth/personal-workspace.ts";
import { assertRegistrationAllowed } from "../../auth/registration-gate.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/register (doc 04 section 10.2, doc 02 sections 2.2 and 2.6, doc 10 T8). Whether an
// address already has an account is the one thing the answer must never say: the checks that can refuse a
// request read the deployment's settings, the password and the address alone (the registration policy sees
// the address and the path, doc 01 section 13.5), and what follows is the same work whatever the database
// finds. Both outcomes hash the password, write in one transaction and queue one `mail.send` job for the
// account identifier this request generated. Only a created account has it, so for an address that already
// has an account the job finds nobody and sends nothing: a registration cannot make mail reach another
// account's owner, nor reissue that account's verification token. A deployment that does not require
// verification has no verification step to wait for, so a created account also gets its personal workspace
// in that transaction (doc 02 section 2.2); the difference between the two outcomes is rows of that
// transaction, which the timing of the answer does not carry, since the password hash dominates it.

const CLOSED = "Public registration is not open on this instance.";
const MAIL_UNAVAILABLE = "Email delivery is not available on this instance.";
const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";

export interface RegisterRouteOptions {
  readonly store: Pick<RegistrationStore, "registerAccount">;
  /** The settings in force: the operator's keys, else the composition's defaults. */
  readonly settings: RegistrationSettings;
  /** The mail port: the verification email is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
  /** The password policy every password-setting flow goes through. */
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
}

export function registerRoute({ store, settings, mail, passwordPolicy, hashPassword }: RegisterRouteOptions): RouteBinding {
  return route(register).handle(async ({ body }, context) => {
    const unavailable = registrationUnavailable(settings, mail.available);
    if (unavailable === "registration_closed") {
      throw new ProblemError("registration_closed", CLOSED);
    }
    if (unavailable === "mail_unavailable") {
      throw new ProblemError("mail_unavailable", MAIL_UNAVAILABLE);
    }

    const problems = passwordPolicy.check(body.password);
    if (problems.length > 0) {
      throw new ProblemError("weak_password", problems.includes("breached") ? BREACHED_DETAIL : LENGTH_DETAIL, {
        errors: problems.map((code) => ({ path: "password", code })),
      });
    }

    const email = normalizeEmail(body.email);
    const hooks = context.get("hooks");
    if (hooks === undefined) {
      throw new Error("the register route was reached without the hook dispatcher");
    }
    await assertRegistrationAllowed(hooks, { email, path: "self-registration" });

    const accountId = uuidv7();
    const passwordHash = await hashPassword(body.password);
    const mailJobs = mail.available ? [queueMailSend(uuidv7(), "verifyEmail", accountId)] : [];
    await store.registerAccount({
      accountId,
      email,
      displayName: body.displayName,
      passwordHash,
      locale: registrationLocale(context.req.raw.headers.get("accept-language")),
      onCreated: [...mailJobs, queueDomainEvent(uuidv7(), "account.created", { accountId, path: "self-registration" })],
      onTaken: mailJobs,
      // With no verification to wait for, the personal workspace is made with the account (doc 02 section 2.2).
      ...(settings.emailVerificationRequired ? {} : { afterCreated: provisionWorkspaceIn }),
    });
    return { status: 202 };
  });
}
