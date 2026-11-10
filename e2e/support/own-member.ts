import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, type APIResponse, type PlaywrightWorkerArgs } from "@playwright/test";
import { appOrigin, STORAGE_STATE } from "./environment.ts";
import { invitationLink, waitForMail } from "./mailpit.ts";

// A member that one journey makes for itself and removes when it ends, for a journey that needs the password of the account (to
// confirm it is the member, as the shared prompt of the app asks for a new session) or an account that has no workspace. The owner
// of the instance signed in with a password nobody keeps, and the members of support/member.ts keep none either. The owner invites
// an address, the mail is read from Mailpit, and the address accepts as a new account with a password made up for the run. The
// session is kept as the state the journey starts from. The password is never printed.

type Playwright = PlaywrightWorkerArgs["playwright"];

const NO_SESSION = { cookies: [], origins: [] };

export interface OwnMember {
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
}

async function expectStatus(response: APIResponse, status: number, what: string): Promise<void> {
  const body = await response.text().catch(() => "");
  expect(response.status(), `${what} answered ${String(response.status())}: ${body}`).toBe(status);
}

function mutation(data?: unknown): { headers: Record<string, string>; data?: unknown } {
  // A mutation must come from the origin the server is configured with, and be JSON with or without a body.
  return { headers: { origin: appOrigin(), "content-type": "application/json" }, ...(data === undefined ? {} : { data }) };
}

/** Invites `<name>-<token>@example.test`, accepts as a new account in English, and keeps the session of the account in `statePath`. */
export async function provisionOwnMember(playwright: Playwright, name: string, statePath: string): Promise<OwnMember> {
  const email = `${name}-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const options = { baseURL: appOrigin(), ignoreHTTPSErrors: true } as const;
  const owner = await playwright.request.newContext({ ...options, storageState: STORAGE_STATE });
  // The context inherits the storage state of the project unless it is given one: this one starts without a session.
  const visitor = await playwright.request.newContext({ ...options, storageState: NO_SESSION });
  try {
    await expectStatus(await owner.post("/api/v1/invitations", mutation({ email, role: "member" })), 201, "POST /api/v1/invitations");
    const mail = await waitForMail(email);
    const invitation = new URL(invitationLink(mail.text, appOrigin())).pathname.slice("/invite/".length);
    await expectStatus(await visitor.post("/api/v1/invitations/accept", mutation({ token: invitation, displayName: name, password })), 201, "POST /api/v1/invitations/accept");
    // The member's language is the account's, so it is set rather than left to what the sign-up chose.
    await expectStatus(await visitor.patch("/api/v1/me", mutation({ locale: "en" })), 200, "PATCH /api/v1/me");
    const me = (await (await visitor.get("/api/v1/me")).json()) as { account?: { id?: unknown } };
    const accountId = me.account?.id;
    if (typeof accountId !== "string") {
      throw new Error("GET /api/v1/me answered without the account's id");
    }
    mkdirSync(dirname(statePath), { recursive: true });
    await visitor.storageState({ path: statePath });
    return { email, password, accountId };
  } finally {
    await owner.dispose();
    await visitor.dispose();
  }
}

/**
 * The owner removes the member from the workspace, with the member's bookmarks, so the account is left with no workspace. A member
 * that is not in the workspace any more (the journey removed it) is not an error: the call is made again when the journey ends.
 */
export async function removeFromWorkspace(playwright: Playwright, member: OwnMember): Promise<void> {
  const owner = await playwright.request.newContext({ baseURL: appOrigin(), ignoreHTTPSErrors: true, storageState: STORAGE_STATE });
  try {
    const removed = await owner.delete(`/api/v1/members/${member.accountId}`, mutation({ content: "delete" }));
    const body = await removed.text().catch(() => "");
    expect([200, 404], `DELETE /api/v1/members/{accountId} answered ${String(removed.status())}: ${body}`).toContain(removed.status());
  } finally {
    await owner.dispose();
  }
}
