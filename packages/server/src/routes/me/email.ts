import { cancelEmailChange, cancelPendingEmailChange, confirmEmailChange, requestEmailChange } from "@slugbase/contracts";
import { hashCredentialToken, normalizeEmail, type MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { emailLimitKey } from "../../auth/email-limit.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// POST /api/v1/me/email, POST /api/v1/me/email/confirm, POST /api/v1/me/email/cancel and DELETE
// /api/v1/me/email/pending (doc 04 sections 4.5, 7 and 10.3, doc 02 sections 2.6 and 1, doc 10 T4, T8 and T18).
//
// The request declares `reauth`, so the authorization stage has refused a session that has not re-authenticated
// within ten minutes before this handler runs. Whether the address is free is what the answer must never say:
// the request counts against the per-target-address limit whatever the address is, records it as the account's
// pending one, queues the mail job in the transaction that records it, and answers 202. Only the job decides
// whether to issue a token. It mails the notice to the current address first and the confirmation to the new
// one after that, to an address that is free and to nobody else, so nothing is sent to another account and no
// confirmation link exists before the owner's address has been told.
//
// Both redemptions are anonymous: the emailed token is the credential. The confirmation moves the account to
// the address, and the "this wasn't me" link cancels the change and deletes every session of the account; used
// after the confirmation it also puts the old address back. An unknown, used, expired, replaced or foreign token, and an address that another account holds by the time
// of the confirmation, are one answer.

const UNAUTHENTICATED = "Authentication is required.";
const REFUSED = "The link is invalid or has expired.";

export interface EmailChangeRoutesOptions {
  readonly store: Pick<AuthStore, "emailKey" | "requestEmailChange" | "cancelPendingEmailChange" | "confirmEmailChange" | "cancelEmailChange">;
  /** The mail port: the emails are queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
}

function accountOf(context: ChainContext): string {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal.accountId;
}

export function emailChangeRoutes({ store, mail }: EmailChangeRoutesOptions): RouteBinding[] {
  return [
    route(requestEmailChange).handle(async ({ body }, context) => {
      const accountId = accountOf(context);
      const takeEmailLimit = context.get("takeEmailLimit");
      if (takeEmailLimit === undefined) {
        throw new Error("the email-change route was reached without the rate-limit stage that counts attempts per email");
      }
      await takeEmailLimit(context, await emailLimitKey(store, body.email));

      const jobs = mail.available ? [queueMailSend(uuidv7(), "emailChange", accountId)] : [];
      if (!(await store.requestEmailChange({ accountId, email: normalizeEmail(body.email), jobs }))) {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      return { status: 202 };
    }),

    route(confirmEmailChange).handle(async ({ body }) => {
      const tokenHash = hashCredentialToken(body.token);
      if (tokenHash === undefined || (await store.confirmEmailChange(tokenHash)) === undefined) {
        throw new ProblemError("token_expired", REFUSED);
      }
      return { status: 204 };
    }),

    route(cancelEmailChange).handle(async ({ body }) => {
      const tokenHash = hashCredentialToken(body.token);
      if (tokenHash === undefined || (await store.cancelEmailChange(tokenHash)) === undefined) {
        throw new ProblemError("token_expired", REFUSED);
      }
      return { status: 204 };
    }),

    route(cancelPendingEmailChange).handle(async (_request, context) => {
      if (!(await store.cancelPendingEmailChange(accountOf(context)))) {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      return { status: 204 };
    }),
  ];
}
