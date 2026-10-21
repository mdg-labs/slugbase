import type { ClassifiedOperation } from "@slugbase/testing/tenancy";
import type { TestDatabase } from "@slugbase/testing/db";
import { FIXTURES } from "../contract/fixtures.ts";
import { buildRequest, type OperationFixture, type RequestParts } from "../contract/walker.ts";
import { seedAccount } from "../auth/support.ts";
import { SESSION_COOKIE, send, type World } from "../workspaces/support.ts";

// The principals and the audit reader of the instance-admin suite (doc 08 section 3.3, doc 10 T3 and T15). Each
// principal is a real sign-in with the production password hash; the second factor is set on the account row
// directly, the way the route suites do it, because the policy reads the row and not a code.

export interface Principal {
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
  /** The cookie header of the session. */
  readonly cookie: string;
}

export interface PrincipalOptions {
  /** The account holds the instance-admin flag. */
  readonly flag: boolean;
  /** The account has a second factor enrolled. */
  readonly mfa: boolean;
  /** The account signs in after the factor is enrolled, so its session is the pending one. */
  readonly partial?: boolean;
  /** The session re-authenticates just now, which moves the window of the operations that ask for it. */
  readonly reauth?: boolean;
}

export async function enrolSecondFactor(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${accountId}`;
  });
}

/** A verified account signed in as the options say. A partial session cannot re-authenticate, so `partial` and `reauth` do not go together. */
export async function signIn(database: TestDatabase, world: World, options: PrincipalOptions): Promise<Principal> {
  const account = await seedAccount(database, { emailVerified: true, instanceAdmin: options.flag });
  if (options.mfa && options.partial === true) {
    await enrolSecondFactor(database, account.id);
  }
  const response = await send(world, "POST", "/api/v1/auth/login", {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  if (options.mfa && options.partial !== true) {
    // The sign-in came first, so the session is a complete one, as it is after the code is accepted.
    await enrolSecondFactor(database, account.id);
  }
  const principal = { accountId: account.id, email: account.email, password: account.password, cookie: `${SESSION_COOKIE}=${token}` };
  if (options.reauth === true) {
    await reauthenticate(world, principal);
  }
  return principal;
}

export async function reauthenticate(world: World, principal: Principal): Promise<void> {
  const response = await send(world, "POST", "/api/v1/me/reauth", { cookie: principal.cookie }, { password: principal.password });
  if (response.status !== 204) {
    throw new Error(`could not re-authenticate: ${String(response.status)}`);
  }
}

/** An instance admin with a second factor on a complete session that re-authenticated just now. */
export function signInAdmin(database: TestDatabase, world: World, options: { readonly reauth?: boolean } = {}): Promise<Principal> {
  return signIn(database, world, { flag: true, mfa: true, reauth: options.reauth ?? true });
}

export interface InstanceEvent {
  readonly actor_account_id: string | null;
  readonly action: string;
  readonly entity_id: string | null;
}

/** The deployment-level audit stream (events with no workspace), oldest first. */
export async function instanceEvents(database: TestDatabase): Promise<InstanceEvent[]> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<InstanceEvent[]>`SELECT actor_account_id, action, entity_id::text AS entity_id FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`;
  });
  return [...rows];
}

export async function clearInstanceEvents(database: TestDatabase): Promise<void> {
  await database.owner`TRUNCATE pgboss.job`;
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM audit_events WHERE workspace_id IS NULL`;
  });
}

export const codeOf = async (response: Response): Promise<string | undefined> => {
  const body = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
};

/** An identifier no row holds, for the path parameters of an operation no fixture names. */
export const UNKNOWN_ID = "0192f3a0-eeee-7000-8000-00000000dead";

export function partsOf(operation: Pick<ClassifiedOperation, "operationId" | "method" | "path" | "pathParameters">): OperationFixture {
  const fixture = Object.hasOwn(FIXTURES, operation.operationId) ? FIXTURES[operation.operationId] : undefined;
  if (fixture !== undefined) {
    return fixture;
  }
  const path = Object.fromEntries(operation.pathParameters.map((name) => [name, UNKNOWN_ID]));
  return { path, ...(["post", "put", "patch"].includes(operation.method) ? { body: {} } : {}) };
}

export function callOperation(world: World, operation: Pick<ClassifiedOperation, "operationId" | "method" | "path" | "pathParameters">, cookie?: string, headers: Record<string, string> = {}, foreign = false): Promise<Response> {
  const fixture = partsOf(operation);
  // The request naming the resources of another workspace, where the operation takes any, and its own otherwise.
  return callParts(world, operation, foreign ? (fixture.foreign ?? fixture) : fixture, cookie, headers);
}

/** The request of the operation with the given path, query and body, whose parameters the caller chose. */
export function callParts(world: World, operation: Pick<ClassifiedOperation, "method" | "path">, parts: RequestParts, cookie?: string, headers: Record<string, string> = {}): Promise<Response> {
  const url = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(parts.path?.[name] ?? UNKNOWN_ID));
  const query = Object.entries(parts.query ?? {}).flatMap(([name, value]) => (typeof value === "string" ? [value] : value).map((item) => `${name}=${encodeURIComponent(item)}`));
  return world.server.fetch(
    buildRequest({
      method: operation.method,
      url: query.length === 0 ? url : `${url}?${query.join("&")}`,
      body: parts.body,
      credentials: { headers: { ...(cookie === undefined ? {} : { cookie }), ...headers } },
      origin: world.origin,
    }),
  );
}

/**
 * A digest of everything the workspace holds that an operation of the tenant-scoped set reads or writes: the workspace row, its settings, its
 * members, its invitations and its audit events, read as slugbase_system, plus the number of queued jobs (a resent invitation queues a mail).
 */
export async function workspaceContent(database: TestDatabase, workspaceId: string): Promise<string> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(r::text, '|' ORDER BY r.id) FROM workspaces r WHERE r.id = ${workspaceId}), '') || '#' ||
        coalesce((SELECT string_agg(r::text, '|' ORDER BY r.workspace_id) FROM workspace_settings r WHERE r.workspace_id = ${workspaceId}), '') || '#' ||
        coalesce((SELECT string_agg(r::text, '|' ORDER BY r.account_id) FROM workspace_members r WHERE r.workspace_id = ${workspaceId}), '') || '#' ||
        coalesce((SELECT string_agg(r::text, '|' ORDER BY r.id) FROM workspace_invitations r WHERE r.workspace_id = ${workspaceId}), '') || '#' ||
        coalesce((SELECT string_agg(r::text, '|' ORDER BY r.id) FROM audit_events r WHERE r.workspace_id = ${workspaceId}), '')
      ) AS digest`;
  });
  const digest = rows[0]?.digest;
  if (digest === undefined) {
    throw new Error("the digest query returned no row");
  }
  const jobs = await database.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job`;
  return `${digest}:${String(jobs[0]?.count)}`;
}
