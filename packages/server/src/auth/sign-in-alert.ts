import type { AuthStore, QueuedJob } from "@slugbase/db";
import { queueMailSend } from "../worker/jobs/mail-send.ts";
import { uuidv7 } from "./uuidv7.ts";
import { userAgentFamily } from "./user-agent.ts";

// The "new sign-in" email of a password sign-in (doc 02 section 12). It is decided once the sign-in is
// complete and queued in the transaction that makes the session full, so a session that is not made
// queues none.

/** Where a sign-in came from, as the session stores it. */
export interface SignInDevice {
  /** The coarse network of the client, or null when its address is unknown. */
  readonly ipPrefix: string | null;
  readonly userAgent: string | null;
}

/**
 * The "new sign-in" job for a sign-in that is about to become a full session, or nothing: the account turned
 * the alerts off, this is its first session, or a live session of the account shares both the user-agent
 * family and the stored IP prefix of the device (doc 02 section 12). The database finds the live sessions of
 * the same prefix; the families are compared here, because the database does not know them. The job carries
 * the time, the browser family and the network prefix, so that it is sent whatever becomes of the session or
 * the switch before the worker runs.
 */
export async function newSignInJobs(
  store: Pick<AuthStore, "signInAlertContext">,
  accountId: string,
  device: SignInDevice,
  signedInAt: Date,
): Promise<readonly QueuedJob[]> {
  const context = await store.signInAlertContext(accountId, device.ipPrefix);
  if (context === undefined || !context.alertsOn || !context.signedInBefore) {
    return [];
  }
  const family = userAgentFamily(device.userAgent);
  if (context.userAgentsOnNetwork.some((userAgent) => userAgentFamily(userAgent) === family)) {
    return [];
  }
  return [
    queueMailSend(uuidv7(), "newSignIn", accountId, {
      signedInAt: signedInAt.toISOString(),
      ...(family === null ? {} : { browser: family }),
      ...(device.ipPrefix === null ? {} : { network: device.ipPrefix }),
    }),
  ];
}
