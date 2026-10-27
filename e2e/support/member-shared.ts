import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { STORAGE_STATE } from "./environment.ts";
import { MAIL_WAIT_MS } from "./mailpit.ts";

// What the shared members (support/member.ts) wait for and where they keep their state, without the Playwright imports of that file, so
// that a unit test can read it.

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

/**
 * Where the sessions of the shared members, and the files the journeys use to agree on who provisions them, are kept: a directory of its
 * own beside the session of the setup project, so that clearing one run's members leaves that session alone.
 */
export const SHARED_MEMBERS_DIR = join(dirname(STORAGE_STATE), "members");

/**
 * Where the session of the shared member `name` is kept. Every run of the journeys starts without the files of the run before it
 * (`clearSharedMembers`, called by the global setup), and the members of one run belong to the one stack the run is made against, so the
 * name holds nothing more than the member's.
 */
export function sharedMemberState(name: string, dir: string = SHARED_MEMBERS_DIR): string {
  return join(dir, `${name}.json`);
}

/**
 * Removes the sessions of the shared members and the files beside them that an earlier run left. The stack of that run is gone, and a
 * later stack that draws the same port would otherwise be handed a session it never issued; used by the global setup.
 */
export function clearSharedMembers(dir: string = SHARED_MEMBERS_DIR): void {
  rmSync(dir, { recursive: true, force: true });
}
