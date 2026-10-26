import { appOrigin } from "./environment.ts";
import { totpCode, totpStep } from "./totp.ts";

// What an instance admin does through the product's own API (doc 04 section 10.10): the first-run owner turns
// on an authenticator app, which the `instanceAdmin` policy needs besides the flag, and then creates workspaces
// for accounts. CE does not let an ordinary account create one (ALLOW_WORKSPACE_CREATION is false), so a journey
// that needs a second workspace has an instance admin make it. A message that fails here names the call and its
// status, never a password, a setup key or a code.

/** The part of Playwright's `APIRequestContext` these calls use, so that a unit test can stand in for it. */
export interface ApiResponse {
  ok: () => boolean;
  status: () => number;
  json: () => Promise<unknown>;
}

export interface ApiClient {
  get: (path: string) => Promise<ApiResponse>;
  post: (path: string, options: { headers: Record<string, string>; data?: unknown }) => Promise<ApiResponse>;
}

export type WorkspaceOwner = { ownerAccountId: string } | { ownerEmail: string };

export interface CreatedWorkspace {
  id: string;
  name: string;
}

const ME_PATH = "/api/v1/me";
const REAUTH_PATH = "/api/v1/me/reauth";
const ENROLMENT_PATH = "/api/v1/me/mfa/enrollment";
const ENROLMENT_CONFIRM_PATH = "/api/v1/me/mfa/enrollment/confirm";
const INSTANCE_WORKSPACES_PATH = "/api/v1/instance/workspaces";

function fail(call: string, response: ApiResponse): never {
  throw new Error(`${call} answered ${String(response.status())}`);
}

// A mutation must come from the origin the server is configured with and be sent as JSON, with or without a body.
function mutation(origin: string, data?: unknown): { headers: Record<string, string>; data?: unknown } {
  const headers = { origin, "content-type": "application/json" };
  return data === undefined ? { headers } : { headers, data };
}

/** The identifier of the signed-in account. */
export async function ownAccountId(api: ApiClient): Promise<string> {
  const response = await api.get(ME_PATH);
  if (!response.ok()) {
    fail(`GET ${ME_PATH}`, response);
  }
  const id = ((await response.json()) as { account?: { id?: unknown } }).account?.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(`GET ${ME_PATH} answered without an account identifier`);
  }
  return id;
}

/**
 * Turns on an authenticator app for the signed-in account through the API the security page uses: the password
 * is confirmed, the enrolment is started and its setup key answered with the code the key gives now. The session
 * cookie of the request context is replaced by the confirmation, so a browser context that shares it carries the
 * new session. The setup key and the backup codes are not kept: the `instanceAdmin` policy asks for an enrolled
 * second factor, not for a code.
 */
export async function enrolSecondFactor(api: ApiClient, password: string, origin: string = appOrigin(), now: () => number = Date.now): Promise<void> {
  const reauth = await api.post(REAUTH_PATH, mutation(origin, { password }));
  if (reauth.status() !== 204) {
    fail(`POST ${REAUTH_PATH}`, reauth);
  }
  const started = await api.post(ENROLMENT_PATH, mutation(origin));
  if (!started.ok()) {
    fail(`POST ${ENROLMENT_PATH}`, started);
  }
  const key = ((await started.json()) as { secret?: unknown }).secret;
  if (typeof key !== "string" || key === "") {
    throw new Error(`POST ${ENROLMENT_PATH} answered without a setup key`);
  }
  const confirmed = await api.post(ENROLMENT_CONFIRM_PATH, mutation(origin, { code: totpCode(key, totpStep(now())) }));
  if (!confirmed.ok()) {
    fail(`POST ${ENROLMENT_CONFIRM_PATH}`, confirmed);
  }
}

/**
 * Creates a workspace as the instance admin of the signed-in session: with the account as its owner, so the
 * account is a member of it, or, for an address, with a pending owner invitation and no member. The session must
 * be an instance admin's and its account must have a second factor (see `enrolSecondFactor`).
 */
export async function createWorkspace(api: ApiClient, name: string, owner: WorkspaceOwner, origin: string = appOrigin()): Promise<CreatedWorkspace> {
  const response = await api.post(INSTANCE_WORKSPACES_PATH, mutation(origin, { name, ...owner }));
  if (response.status() !== 201) {
    fail(`POST ${INSTANCE_WORKSPACES_PATH}`, response);
  }
  const created = (await response.json()) as { id?: unknown; name?: unknown };
  if (typeof created.id !== "string" || created.name !== name) {
    throw new Error(`POST ${INSTANCE_WORKSPACES_PATH} answered a workspace other than the one asked for`);
  }
  return { id: created.id, name: created.name };
}
