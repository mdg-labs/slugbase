import { MAIL_WAIT_MS } from "./mailpit.ts";

// What the shared members (support/member.ts) wait for, without the Playwright imports of that file, so that a unit test can read it.

/** How long a journey waits for the one that accepts the invitation to keep the session. */
export const READY_TIMEOUT_MS = 60_000;

/** What the requests of the journey that provisions the member take besides the wait for the mail: the invitation, the accept and the language. */
const REQUESTS_MS = 15_000;

/** The longest the journey that provisions the member takes: the invitation, the wait for its mail, and the requests that follow it. */
export const PROVISION_MS = MAIL_WAIT_MS + REQUESTS_MS;

/** What a hook has left for its own work (a destination to start, bookmarks to make) once the member is there. */
const HOOK_WORK_MS = 30_000;

/**
 * The timeout of a hook that calls `ensureSharedMember`. The hook of a journey that provisions waits for the mail and makes the
 * requests, the hooks of the others wait up to `READY_TIMEOUT_MS`, and the default timeout of 30 seconds ends the hook before either
 * limit is reached: the journey that provisions then leaves neither a `.ready` nor a `.failed` file, and the others wait on it.
 */
export const SHARED_MEMBER_HOOK_TIMEOUT_MS = Math.max(READY_TIMEOUT_MS, PROVISION_MS) + HOOK_WORK_MS;
