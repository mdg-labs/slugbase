import { forgotPassword } from "@slugbase/contracts";
import { normalizeEmail, type MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { emailLimitKey } from "../../auth/email-limit.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/password/forgot (doc 04 sections 4.5, 7 and 10.2, doc 02 sections 2.5 and 1, doc 10 T8 and
// T9). Whether an address has an account, and whether that account has a password, is what the answer must
// never say. The request counts against the per-address limit whatever the address is, looks it up, queues one
// `mail.send` job and answers 202. The job carries the account's identifier when an address has one and an
// identifier no account holds otherwise, so every outcome is the same work. Only the job decides whether to
// issue a token: it does for an account that has a password and a verified address, and for nothing else. A
// deployment that cannot send mail queues nothing and answers the same.

export interface ForgotPasswordRouteOptions {
  readonly store: Pick<AuthStore, "emailKey" | "requestPasswordReset">;
  /** The mail port: the reset email is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
}

export function forgotPasswordRoute({ store, mail }: ForgotPasswordRouteOptions): RouteBinding {
  return route(forgotPassword).handle(async ({ body }, context) => {
    const takeEmailLimit = context.get("takeEmailLimit");
    if (takeEmailLimit === undefined) {
      throw new Error("the forgot-password route was reached without the rate-limit stage that counts attempts per email");
    }
    await takeEmailLimit(context, await emailLimitKey(store, body.email));

    const job = (accountId: string) => (mail.available ? [queueMailSend(uuidv7(), "passwordReset", accountId)] : []);
    await store.requestPasswordReset({ email: normalizeEmail(body.email), onKnown: job, onUnknown: job(uuidv7()) });
    return { status: 202 };
  });
}
