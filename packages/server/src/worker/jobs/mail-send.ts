import { ACCOUNT_NOTIFICATIONS, CREDENTIAL_TOKEN_TTL_SECONDS, accountNotification, generateCredentialToken, type MailMessage } from "@slugbase/core";
import { accountProfileRepository, credentialTokenRepository, type QueuedJob } from "@slugbase/db";
import { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { JobDefinition } from "../job.ts";
import { defineJob } from "../job.ts";

// `mail.send` (doc 01 section 8.1): one transactional email to an account. The job
// carries the template and the account's identifier and nothing else; the worker
// reads the address and the language of the account when it sends, so the payload
// holds neither an address nor a message body, and neither does a log line or an
// error report of a failed attempt (doc 10 T7). A request never waits for it: it
// queues the job in its own transaction and answers.
//
// The verification email carries a one-time token (doc 02 section 2.6). The job
// makes it when it runs, stores only its hash and puts the value into the message
// that goes straight to the mail port, so it is in no queued payload, log line or
// error report. It sends nothing to an account that is gone, disabled or already
// verified; a retry makes a new token, which replaces the earlier unused one.
//
// The "new sign-in" email (doc 02 section 12) carries what it shows, taken when the sign-in happened: the
// time, the browser family and the coarse network prefix, none of which is a secret. The alert was queued
// while the account's switch was on, so it is sent whatever becomes of the session or the switch before the
// worker runs, or between attempts.

export const MAIL_SEND_JOB = "mail.send";

/** What the "new sign-in" email shows of the sign-in; the browser and the network are absent when unknown. */
export interface NewSignInDetails {
  /** RFC 3339 UTC. */
  readonly signedInAt: string;
  readonly browser?: string;
  readonly network?: string;
}

/** The request id of the tenant transaction a send reads the account in; there is no request. */
const JOB_REQUEST_ID = MAIL_SEND_JOB;

export const mailSendJob = defineJob({
  name: MAIL_SEND_JOB,
  payload: z.object({
    template: z.enum(ACCOUNT_NOTIFICATIONS),
    accountId: z.uuid(),
    signedInAt: z.iso.datetime().optional(),
    browser: z.string().min(1).max(64).optional(),
    network: z.string().min(1).max(64).optional(),
  }),
  // Delivery is at least once: a retry after an attempt that failed past the point the relay took the
  // message sends it again, and nothing here can tell the two apart.
  handle: async ({ template, accountId, signedInAt, browser, network }, context) => {
    const message = await context.withTenant({ accountId, requestId: JOB_REQUEST_ID }, async (tx): Promise<MailMessage | undefined> => {
      const profile = await accountProfileRepository(tx).profile();
      if (profile === undefined) {
        // The account is gone since the job was queued; there is nobody to tell and a retry would find the same.
        context.logger.warn("Mail not sent; the account no longer exists", { template });
        return undefined;
      }
      if (template === "newSignIn") {
        if (signedInAt === undefined) {
          context.logger.warn("Mail not sent; the sign-in alert names no sign-in", { template });
          return undefined;
        }
        return accountNotification(template, profile, {
          signedInAt,
          ...(browser === undefined ? {} : { browser }),
          ...(network === undefined ? {} : { network }),
        });
      }
      if (template !== "verifyEmail") {
        return accountNotification(template, profile);
      }
      if (profile.emailVerified) {
        return undefined;
      }
      const token = generateCredentialToken();
      const issued = await credentialTokenRepository(tx).issue({
        id: uuidv7(),
        purpose: "email_verify",
        tokenHash: token.hash,
        targetEmail: null,
        ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS.email_verify,
      });
      if (!issued) {
        context.logger.warn("Mail not sent; the account cannot receive a verification token", { template });
        return undefined;
      }
      return accountNotification(template, profile, { token: token.value });
    });
    if (message !== undefined) {
      await context.adapters.mail.send(message);
    }
  },
});

/**
 * The job that sends `template` to the account, validated against the payload schema; for a transaction that
 * queues it. `signIn` is what a "new sign-in" email shows.
 */
export function queueMailSend(id: string, template: (typeof ACCOUNT_NOTIFICATIONS)[number], accountId: string, signIn?: NewSignInDetails): QueuedJob {
  const payload = mailSendJob.parse({ template, accountId, ...signIn });
  return {
    id,
    queue: MAIL_SEND_JOB,
    data: {
      template: payload.template,
      accountId: payload.accountId,
      ...(payload.signedInAt === undefined ? {} : { signedInAt: payload.signedInAt }),
      ...(payload.browser === undefined ? {} : { browser: payload.browser }),
      ...(payload.network === undefined ? {} : { network: payload.network }),
    },
  };
}

/** The mail job the worker always runs, whatever modules it composes. */
export const mailJobs: readonly JobDefinition[] = [mailSendJob];
