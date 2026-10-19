import { generateCredentialToken, invitationMessage } from "@slugbase/core";
import { accountProfileRepository, invitationRepository, type QueuedJob } from "@slugbase/db";
import { z } from "zod";
import { defineJob } from "../job.ts";

// `invitation.send` (doc 02 section 3.4, doc 10 T4 and T19): the email that carries an invitation's link. The job
// carries the invitation's identifier, the workspace's, the inviting account's and the language the message
// is written in, and nothing else: no address, no name, no token. It makes the token when it runs, stores only
// its hash, which ends the link of any earlier send of the same invitation, and puts the value into the message
// that goes straight to the mail port, so the token is in no queued payload, log line or error report. The
// worker reads the address, the workspace's name and the role from the invitation in a transaction acting in
// its workspace as the inviting account, so what the message says is what the invitation says when it is
// sent. It sends nothing for an invitation that is no longer pending or has expired, and a retry after an
// attempt that failed makes a new token, which replaces the earlier one.

export const INVITATION_SEND_JOB = "invitation.send";

/** The request id of the tenant transaction a send runs in; there is no request. */
const JOB_REQUEST_ID = INVITATION_SEND_JOB;

export const invitationSendJob = defineJob({
  name: INVITATION_SEND_JOB,
  payload: z.object({
    invitationId: z.uuid(),
    workspaceId: z.uuid(),
    accountId: z.uuid(),
    locale: z.string().min(2).max(16),
  }),
  handle: async ({ invitationId, workspaceId, accountId, locale }, context) => {
    const token = generateCredentialToken();
    const prepared = await context.withTenant({ accountId, workspaceId, requestId: JOB_REQUEST_ID }, async (tx) => {
      const issued = await invitationRepository(tx).issueToken(invitationId, token.hash);
      if (issued === undefined) {
        return undefined;
      }
      const inviter = await accountProfileRepository(tx).profile();
      return { issued, inviterName: inviter?.displayName ?? "" };
    });
    if (prepared === undefined) {
      // Revoked, accepted, expired or gone since the job was queued: there is no link to send and a retry would find the same.
      context.logger.warn("Mail not sent; the invitation is no longer pending");
      return;
    }
    const { issued, inviterName } = prepared;
    if (issued.role === "owner") {
      context.logger.warn("Mail not sent; the invitation grants a role this email does not carry");
      return;
    }
    await context.adapters.mail.send(
      invitationMessage({ to: issued.email, locale, workspaceName: issued.workspaceName, inviterName, role: issued.role, token: token.value, expiresAt: issued.expiresAt }),
    );
  },
});

/** The job that mails the invitation's link; for the transaction that writes the invitation. */
export function queueInvitationMail(id: string, invitation: { readonly invitationId: string; readonly workspaceId: string; readonly accountId: string; readonly locale: string }): QueuedJob {
  const payload = invitationSendJob.parse(invitation);
  return { id, queue: INVITATION_SEND_JOB, data: { invitationId: payload.invitationId, workspaceId: payload.workspaceId, accountId: payload.accountId, locale: payload.locale } };
}
