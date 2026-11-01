import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, type APIResponse, type PlaywrightWorkerArgs } from "@playwright/test";
import { appOrigin, STORAGE_STATE } from "./environment.ts";
import { invitationLink, waitForMail } from "./mailpit.ts";
import { READY_TIMEOUT_MS, sharedMemberState } from "./member-shared.ts";

// A member of the journeys' own. The owner of the instance signed in with a password nobody keeps, and the journeys that read the
// owner's language or theme queue for the lock of the account's preferences (support/account-preferences.ts), so a journey that does not
// need the owner's account takes a session of its own: it invites an address, accepts the invitation as a new account with a password
// made up for the run, and keeps the session as the state the journey starts from. The journeys that use `sharedMember` accept once
// between them, whichever engine gets there first, and the others wait for the session it keeps. The password is never printed.

type Playwright = PlaywrightWorkerArgs["playwright"];

const NO_SESSION = { cookies: [], origins: [] };

const POLL_MS = 100;

async function expectStatus(response: APIResponse, status: number, what: string): Promise<void> {
  const body = await response.text().catch(() => "");
  expect(response.status(), `${what} answered ${String(response.status())}: ${body}`).toBe(status);
}

function mutation(data?: unknown): { headers: Record<string, string>; data?: unknown } {
  // A mutation must come from the origin the server is configured with, and be JSON with or without a body.
  return { headers: { origin: appOrigin(), "content-type": "application/json" }, ...(data === undefined ? {} : { data }) };
}

/**
 * The owner invites `<name>-<token>@example.test`, the mail is read from Mailpit, and the address accepts as a new account in English.
 * The session of that account is kept in `statePath`.
 */
async function provisionMember(playwright: Playwright, name: string, token: string, statePath: string): Promise<void> {
  const email = `${name}-${token}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const options = { baseURL: appOrigin(), ignoreHTTPSErrors: true } as const;
  const owner = await playwright.request.newContext({ ...options, storageState: STORAGE_STATE });
  // The context inherits the storage state of the project unless it is given one: this one starts without a session.
  const visitor = await playwright.request.newContext({ ...options, storageState: NO_SESSION });
  try {
    await expectStatus(await owner.post("/api/v1/invitations", mutation({ email, role: "member" })), 201, "POST /api/v1/invitations");
    const mail = await waitForMail(email);
    const invitation = new URL(invitationLink(mail.text, appOrigin())).pathname.slice("/invite/".length);
    const accepted = await visitor.post("/api/v1/invitations/accept", mutation({ token: invitation, displayName: `${name} ${token}`, password }));
    await expectStatus(accepted, 201, "POST /api/v1/invitations/accept");
    // The member's language is the account's, so it is set rather than left to what the sign-up chose.
    await expectStatus(await visitor.patch("/api/v1/me", mutation({ locale: "en" })), 200, "PATCH /api/v1/me");
    await visitor.storageState({ path: statePath });
  } finally {
    await owner.dispose();
    await visitor.dispose();
  }
}

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * Makes sure the session of the shared member `name` exists in `sharedMemberState(name)`: the first journey to ask invites and accepts,
 * the others wait for it. A journey that fails to provision says so in a file, so the others fail at once and name it. The member stays
 * in the workspace until the stack is removed.
 */
export async function ensureSharedMember(playwright: Playwright, name: string): Promise<string> {
  const statePath = sharedMemberState(name);
  const claim = `${statePath}.claim`;
  const ready = `${statePath}.ready`;
  const failed = `${statePath}.failed`;
  mkdirSync(dirname(statePath), { recursive: true });
  let first = true;
  try {
    mkdirSync(claim);
  } catch (error) {
    if (!isAlreadyThere(error)) {
      throw error;
    }
    first = false;
  }
  if (first) {
    try {
      await provisionMember(playwright, name, randomBytes(4).toString("hex"), statePath);
      writeFileSync(ready, "");
    } catch (error) {
      writeFileSync(failed, "");
      rmSync(statePath, { force: true });
      throw error;
    }
    return statePath;
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!existsSync(ready)) {
    if (existsSync(failed)) {
      throw new Error(`the journey that provisions the member ${name} failed`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`the member ${name} was not provisioned within ${String(READY_TIMEOUT_MS / 1000)} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return statePath;
}
