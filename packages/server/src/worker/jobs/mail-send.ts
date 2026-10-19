import { ACCOUNT_NOTIFICATIONS, CREDENTIAL_TOKEN_TTL_SECONDS, accountNotification, generateCredentialToken, type MailMessage } from "@slugbase/core";
import { accountProfileRepository, credentialTokenRepository, emailChangeRepository, memberRepository, workspaceRepository, type QueuedJob } from "@slugbase/db";
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
// The password-reset email (doc 02 section 2.5) is made the same way, with a token that works for 1 hour. It
// is sent to an account that has a password and whose address was verified, and to nobody else: the request
// that queued it answered alike for every address, so the decision is the job's. An account nobody verified
// may have been set up by whoever registered the address first, and the verification link, which is what takes
// that setup away, is the way into it.
//
// The two emails of an email change (doc 02 section 2.6) are made the same way by one job, with tokens that work
// for 1 hour: the notice with the "this wasn't me" link, mailed to the account's current address, and then the
// confirmation, mailed to the address the account asked to move to. The confirmation is sent only after the
// notice was handed to the mail port, so no confirmation link exists outside this process before the owner's
// address has been told; a failed send of either runs the whole job again, which makes new tokens that replace
// the unused ones; a run that finds the address taken issues no confirmation and deletes the unused one an
// earlier run issued. The request that queued the job answered alike for every address, so the decision is the job's:
// a token is issued, and the mail sent, only when the account has a verified address and a change is still
// pending, and the confirmation only to an address that is free, so nothing is mailed to another account. A
// change cancelled before the worker runs sends nothing.
//
// The "ownership transferred to you" email (doc 02 section 12) names the workspace and the owner who made the
// recipient one. The job carries the identifiers of both and nothing else: the worker reads the workspace's name
// and the owner's display name in a transaction acting in that workspace as the recipient, so a rename or a
// departure between the request and the send is what the message shows. It is sent only while the recipient is
// still an owner of the workspace.
//
// The "new sign-in" email (doc 02 section 12) carries what it shows, taken when the sign-in happened: the
// time, the browser family and the coarse network prefix, none of which is a secret. The alert was queued
// while the account's switch was on, so it is sent whatever becomes of the session or the switch before the
// worker runs, or between attempts.

export const MAIL_SEND_JOB = "mail.send";

/** The templates a job can name: the notice of an email change goes out in the job of its confirmation. */
const MAIL_JOB_TEMPLATES = z.enum(ACCOUNT_NOTIFICATIONS).exclude(["emailChangeNotice"]);

export type MailJobTemplate = z.infer<typeof MAIL_JOB_TEMPLATES>;

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
    template: MAIL_JOB_TEMPLATES,
    accountId: z.uuid(),
    signedInAt: z.iso.datetime().optional(),
    browser: z.string().min(1).max(64).optional(),
    network: z.string().min(1).max(64).optional(),
    workspaceId: z.uuid().optional(),
    fromAccountId: z.uuid().optional(),
  }),
  // Delivery is at least once: a retry after an attempt that failed past the point the relay took the
  // message sends it again, and nothing here can tell the two apart.
  handle: async ({ template, accountId, signedInAt, browser, network, workspaceId, fromAccountId }, context) => {
    if (template === "ownershipTransferred") {
      if (workspaceId === undefined || fromAccountId === undefined) {
        context.logger.warn("Mail not sent; the ownership notice names no workspace or no previous owner", { template });
        return;
      }
      const notices = await context.withTenant({ accountId, workspaceId, requestId: JOB_REQUEST_ID }, async (tx): Promise<readonly MailMessage[]> => {
        const profile = await accountProfileRepository(tx).profile();
        const workspace = await workspaceRepository(tx).current();
        if (profile === undefined || workspace === undefined || workspace.role !== "owner") {
          // The account or the workspace is gone, or the account is no owner any more; the message would say what is no longer so.
          context.logger.warn("Mail not sent; the account is no longer an owner of the workspace", { template });
          return [];
        }
        const previous = await memberRepository(tx).member(fromAccountId);
        return [accountNotification(template, profile, { workspaceName: workspace.name, transferredBy: previous?.displayName ?? "" })];
      });
      for (const message of notices) {
        await context.adapters.mail.send(message);
      }
      return;
    }
    const messages = await context.withTenant({ accountId, requestId: JOB_REQUEST_ID }, async (tx): Promise<readonly MailMessage[]> => {
      const profile = await accountProfileRepository(tx).profile();
      if (profile === undefined) {
        // The account is gone since the job was queued; there is nobody to tell and a retry would find the same.
        context.logger.warn("Mail not sent; the account no longer exists", { template });
        return [];
      }
      if (template === "newSignIn") {
        if (signedInAt === undefined) {
          context.logger.warn("Mail not sent; the sign-in alert names no sign-in", { template });
          return [];
        }
        return [
          accountNotification(template, profile, {
            signedInAt,
            ...(browser === undefined ? {} : { browser }),
            ...(network === undefined ? {} : { network }),
          }),
        ];
      }
      if (template === "passwordReset") {
        if (!profile.hasPassword || !profile.emailVerified) {
          return [];
        }
        const token = generateCredentialToken();
        const issued = await credentialTokenRepository(tx).issue({
          id: uuidv7(),
          purpose: "password_reset",
          tokenHash: token.hash,
          targetEmail: null,
          ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS.password_reset,
        });
        if (!issued) {
          context.logger.warn("Mail not sent; the account cannot receive a password-reset token", { template });
          return [];
        }
        return [accountNotification(template, profile, { token: token.value })];
      }
      if (template === "emailChange") {
        if (!profile.emailVerified) {
          return [];
        }
        const cancel = generateCredentialToken();
        const noticed = await emailChangeRepository(tx).issue({
          id: uuidv7(),
          purpose: "email_change_cancel",
          tokenHash: cancel.hash,
          ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS.email_change_cancel,
        });
        if (noticed === undefined) {
          return [];
        }
        const confirmation = generateCredentialToken();
        const pending = await emailChangeRepository(tx).issue({
          id: uuidv7(),
          purpose: "email_change",
          tokenHash: confirmation.hash,
          ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS.email_change,
        });
        const notice = accountNotification("emailChangeNotice", profile, { token: cancel.value });
        return pending === undefined ? [notice] : [notice, accountNotification("emailChange", { ...profile, email: pending }, { token: confirmation.value })];
      }
      if (template !== "verifyEmail") {
        return [accountNotification(template, profile)];
      }
      if (profile.emailVerified) {
        return [];
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
        return [];
      }
      return [accountNotification(template, profile, { token: token.value })];
    });
    for (const message of messages) {
      await context.adapters.mail.send(message);
    }
  },
});

/**
 * The job that sends `template` to the account, validated against the payload schema; for a transaction that
 * queues it. `signIn` is what a "new sign-in" email shows.
 */
export function queueMailSend(id: string, template: MailJobTemplate, accountId: string, signIn?: NewSignInDetails): QueuedJob {
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

/**
 * The job that tells `accountId` it became an owner of `workspaceId` through `fromAccountId`; for the transaction that
 * makes the change. The names the message shows are read when it is sent.
 */
export function queueOwnershipTransferredMail(id: string, accountId: string, ownership: { readonly workspaceId: string; readonly fromAccountId: string }): QueuedJob {
  const payload = mailSendJob.parse({ template: "ownershipTransferred", accountId, ...ownership });
  return { id, queue: MAIL_SEND_JOB, data: { template: payload.template, accountId: payload.accountId, workspaceId: ownership.workspaceId, fromAccountId: ownership.fromAccountId } };
}

/** The mail job the worker always runs, whatever modules it composes. */
export const mailJobs: readonly JobDefinition[] = [mailSendJob];
