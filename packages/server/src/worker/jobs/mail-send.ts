import { ACCOUNT_NOTIFICATIONS, accountNotification } from "@slugbase/core";
import { accountProfileRepository, type QueuedJob } from "@slugbase/db";
import { z } from "zod";
import type { ServerModule } from "../../create-server.ts";
import { defineJob } from "../job.ts";

// `mail.send` (doc 01 section 8.1): one transactional email to an account. The job
// carries the template and the account's identifier and nothing else; the worker
// reads the address and the language of the account when it sends, so the payload
// holds neither an address nor a message body, and neither does a log line or an
// error report of a failed attempt (doc 10 T7). A request never waits for it: it
// queues the job in its own transaction and answers.

export const MAIL_SEND_JOB = "mail.send";

/** The request id of the tenant transaction a send reads the account in; there is no request. */
const JOB_REQUEST_ID = MAIL_SEND_JOB;

export const mailSendJob = defineJob({
  name: MAIL_SEND_JOB,
  payload: z.object({ template: z.enum(ACCOUNT_NOTIFICATIONS), accountId: z.uuid() }),
  // Delivery is at least once: a retry after an attempt that failed past the point the relay took the
  // message sends it again, and nothing here can tell the two apart.
  handle: async ({ template, accountId }, context) => {
    const profile = await context.withTenant({ accountId, requestId: JOB_REQUEST_ID }, (tx) => accountProfileRepository(tx).profile());
    if (profile === undefined) {
      // The account is gone since the job was queued; there is nobody to tell and a retry would find the same.
      context.logger.warn("Mail not sent; the account no longer exists", { template });
      return;
    }
    await context.adapters.mail.send(accountNotification(template, profile));
  },
});

/** The job that sends `template` to the account, validated against the payload schema; for a transaction that queues it. */
export function queueMailSend(id: string, template: (typeof ACCOUNT_NOTIFICATIONS)[number], accountId: string): QueuedJob {
  const payload = mailSendJob.parse({ template, accountId });
  return { id, queue: MAIL_SEND_JOB, data: { template: payload.template, accountId: payload.accountId } };
}

/** The mail job the worker always runs, whatever modules it composes. */
export function createMailModule(): ServerModule {
  return {
    name: "@slugbase/server/mail",
    register: () => ({ jobs: [mailSendJob] }),
  };
}
