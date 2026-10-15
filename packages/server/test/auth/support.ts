import { createHash } from "node:crypto";
import { generateApiToken } from "@slugbase/core";
import { apiTokenRepository, createAuthStore, type AuthStore } from "@slugbase/db";
import type { TestDatabase } from "@slugbase/testing/db";
import { hashPassword } from "../../src/auth/password.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter, type MemoryRateLimiter } from "../http/rate-limit-support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// Fixtures for the sign-in tests, written the way the test database allows:
// `accounts` has forced row-level security with the own-row policy, so the table
// owner inserts a row by naming the account in the setting; `sessions` has no
// policy at all, so the owner reads and changes it as slugbase_system (the owner
// is a member of that role, doc 05 section 3.1), which stands for the system
// operations here.

let accountNumber = 0;

export interface SeededAccount {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export interface SeedOptions {
  readonly email?: string;
  readonly password?: string | null;
  readonly disabled?: boolean;
  readonly emailVerified?: boolean;
}

export function storeFor(database: TestDatabase): AuthStore {
  return createAuthStore({ url: appUrl(database), poolSize: 4 });
}

/** Creates an account whose password is hashed with the production parameters. */
export async function seedAccount(database: TestDatabase, options: SeedOptions = {}): Promise<SeededAccount> {
  accountNumber += 1;
  const id = `0192f3a0-bbbb-7000-8000-${accountNumber.toString(16).padStart(12, "0")}`;
  const email = options.email ?? `person${String(accountNumber)}@example.test`;
  const password = options.password === undefined ? `a long password number ${String(accountNumber)}` : options.password;
  const passwordHash = password === null ? null : await hashPassword(password);
  await database.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${id}, true)`;
    await tx`
      INSERT INTO accounts (id, email, display_name, password_hash, disabled_at, email_verified_at)
      VALUES (${id}, ${email}, 'Test account', ${passwordHash}, ${options.disabled === true ? new Date() : null},
              ${options.emailVerified === true ? new Date() : null})`;
  });
  return { id, email, password: password ?? "" };
}

export interface SessionRow {
  id: string;
  token_hash: Buffer;
  account_id: string;
  level: string;
  remember: boolean;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
  ip_prefix: string | null;
  user_agent: string | null;
}

export async function sessionRows(database: TestDatabase, accountId: string): Promise<SessionRow[]> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<SessionRow[]>`SELECT * FROM sessions WHERE account_id = ${accountId} ORDER BY created_at, id`;
  });
  return [...rows];
}

/** Ends the sliding window of every session of the account a second ago. */
export async function expireSessions(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE account_id = ${accountId}`;
  });
}

export async function disableAccount(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${accountId}`;
  });
}

/** Records a password change a moment after the account's sessions were created. */
export async function changePassword(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET password_changed_at = now() + interval '1 second' WHERE id = ${accountId}`;
  });
}

export function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

let workspaceNumber = 0;

/** Creates a workspace as slugbase_system, which stands for the system operation that does: slugbase_app cannot insert one. */
export async function seedWorkspace(database: TestDatabase, options: { readonly name?: string; readonly deleting?: boolean } = {}): Promise<string> {
  workspaceNumber += 1;
  const id = `0192f3a0-cccc-7000-8000-${workspaceNumber.toString(16).padStart(12, "0")}`;
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO workspaces (id, name, deleting_at)
      VALUES (${id}, ${options.name ?? `Workspace ${String(workspaceNumber)}`}, ${options.deleting === true ? new Date() : null})`;
  });
  return id;
}

export async function seedMembership(
  database: TestDatabase,
  membership: { readonly workspaceId: string; readonly accountId: string; readonly role?: "owner" | "admin" | "member"; readonly lastActiveAt?: Date | null },
): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO workspace_members (workspace_id, account_id, role, last_active_at)
      VALUES (${membership.workspaceId}, ${membership.accountId}, ${membership.role ?? "member"}, ${membership.lastActiveAt ?? null})`;
  });
}

let tokenNumber = 0;

export interface SeedTokenOptions {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly scope?: "read" | "read-write";
}

/** Mints an API token of an account for a workspace through the repository, as creating one does; the value is the credential a client sends. */
export async function seedApiToken(database: TestDatabase, options: SeedTokenOptions): Promise<{ readonly id: string; readonly value: string }> {
  tokenNumber += 1;
  const token = generateApiToken();
  const id = `0192f3a0-aaaa-7000-8000-${tokenNumber.toString(16).padStart(12, "0")}`;
  const outcome = await tenantDatabase(database).withTenant({ accountId: options.accountId, requestId: "seed-api-token" }, (tx) =>
    apiTokenRepository(tx).create({
      id,
      workspaceId: options.workspaceId,
      name: `seeded token ${String(tokenNumber)}`,
      scope: options.scope ?? "read",
      tokenHash: token.hash,
      tokenPrefix: token.displayPrefix,
      expiresInDays: 90,
      limit: 10,
    }),
  );
  if (outcome.kind !== "created") {
    throw new Error(`the token could not be seeded: ${outcome.kind}`);
  }
  return { id, value: token.value };
}

export async function removeMembership(database: TestDatabase, workspaceId: string, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
}

/** Sets the active workspace of a session whatever the account's memberships are, as a forged value would be. */
export async function setActiveWorkspace(database: TestDatabase, sessionId: string, workspaceId: string | null): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE sessions SET active_workspace_id = ${workspaceId} WHERE id = ${sessionId}`;
  });
}

export async function lastActiveAt(database: TestDatabase, workspaceId: string, accountId: string): Promise<Date | null> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ last_active_at: Date | null }[]>`
      SELECT last_active_at FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
  return rows[0]?.last_active_at ?? null;
}

export async function setLastActiveAt(database: TestDatabase, workspaceId: string, accountId: string, at: Date | null): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_members SET last_active_at = ${at} WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
}

/** A digest of the workspace's rows in both workspace tables, read as slugbase_system. */
export async function workspaceChecksum(database: TestDatabase, workspaceId: string): Promise<string> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w WHERE w.id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(m::text, '|' ORDER BY m.account_id) FROM workspace_members m WHERE m.workspace_id = ${workspaceId}), '')
      ) AS digest`;
  });
  const digest = rows[0]?.digest;
  if (digest === undefined) {
    throw new Error("the checksum query returned no row");
  }
  return digest;
}

/**
 * How many times longer `probe` takes than `reference`, as the median over
 * `rounds` of the per-round ratio. Each round times both back to back, and the
 * order alternates, so a burst of load on a shared runner lands on both sides of
 * a round and a single slow round moves one ratio of the many, not the median.
 * Both run once first, unmeasured, to warm caches and lazily made state.
 */
export async function medianLatencyRatio(
  reference: () => Promise<unknown>,
  probe: () => Promise<unknown>,
  rounds = 21,
): Promise<number> {
  const timed = async (run: () => Promise<unknown>): Promise<number> => {
    const started = performance.now();
    await run();
    return performance.now() - started;
  };
  await reference();
  await probe();
  const ratios: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    let referenceTime: number;
    let probeTime: number;
    if (round % 2 === 0) {
      referenceTime = await timed(reference);
      probeTime = await timed(probe);
    } else {
      probeTime = await timed(probe);
      referenceTime = await timed(reference);
    }
    ratios.push(probeTime / referenceTime);
  }
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)] ?? 0;
}

export const SESSION_COOKIE = "__Host-slugbase_session";
export const LOGIN = "/api/v1/auth/login";

export interface AuthWorld {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
  /** The limiter the server counts attempts in: its clock only moves when `advance` says so. */
  readonly limiter: MemoryRateLimiter;
}

export interface ServeOptions {
  readonly env?: Record<string, string>;
  /** Raises the login limits so a test that is not about them signs in freely; the limit suites turn it off to run the shipped defaults. */
  readonly openLimits?: boolean;
}

/** The whole chain over the migrated database, as the sign-in suites run it. */
export function serveAuth(database: TestDatabase, store: AuthStore, { env = {}, openLimits = true }: ServeOptions = {}): AuthWorld {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database),
    ...(openLimits ? { RATE_LIMIT_LOGIN_IP: "1000/min", RATE_LIMIT_LOGIN_EMAIL: "1000/hour", RATE_LIMIT_MFA_IP: "1000/min", RATE_LIMIT_MFA_ACCOUNT: "1000/hour" } : {}),
    ...env,
  });
  const limiter = memoryRateLimiter(createRateLimitRegistry(config));
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), rateLimit: limiter, tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, logs, limiter };
}

export interface Attempt {
  readonly email?: string;
  readonly password?: string;
  readonly remember?: boolean;
  readonly body?: unknown;
  readonly cookie?: string;
  readonly forwardedFor?: string;
  readonly userAgent?: string;
}

/** A same-origin JSON POST, as the SPA sends one. */
export function postJson(origin: string, path: string, body: unknown, extra: Pick<Attempt, "cookie" | "forwardedFor" | "userAgent"> = {}): Request {
  const headers = new Headers({ origin, "content-type": "application/json" });
  for (const [name, value] of [["cookie", extra.cookie], ["x-forwarded-for", extra.forwardedFor], ["user-agent", extra.userAgent]] as const) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(body) });
}

export function attemptLogin({ server, origin }: AuthWorld, attempt: Attempt): Promise<Response> {
  const body = attempt.body ?? { email: attempt.email ?? "", password: attempt.password ?? "", remember: attempt.remember ?? false };
  return server.fetch(postJson(origin, LOGIN, body, attempt));
}

export function signInAttempt(world: AuthWorld, account: SeededAccount, extra: Attempt = {}): Promise<Response> {
  return attemptLogin(world, { email: account.email, password: account.password, ...extra });
}

/** The value of the session cookie a response sets, or undefined when it sets none. */
export function issuedToken(response: Response, name = SESSION_COOKIE): string | undefined {
  return new RegExp(`^${name}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

export interface SignedIn {
  readonly token: string;
  readonly sessionId: string;
}

export async function signInAs(world: AuthWorld, database: TestDatabase, account: SeededAccount, extra: Attempt = {}, name = SESSION_COOKIE): Promise<SignedIn> {
  const response = await signInAttempt(world, account, extra);
  const token = issuedToken(response, name);
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const hash = sha256(Buffer.from(token, "base64url"));
  const row = (await sessionRows(database, account.id)).find((candidate) => candidate.token_hash.equals(hash));
  if (row === undefined) {
    throw new Error("the session row is missing");
  }
  return { token, sessionId: row.id };
}

/** A GET of a route that needs a session, with the cookie of `token` under `name`. */
export function getWith({ server, origin }: AuthWorld, path: string, token: string | null, name = SESSION_COOKIE): Promise<Response> {
  return server.fetch(new Request(new URL(path, origin), { headers: token === null ? {} : { cookie: `${name}=${token}` } }));
}

/** Lets `days` days pass for one session: every instant it recorded moves back, so the database clock reads it that much later. */
export async function ageSession(database: TestDatabase, sessionId: string, days: number): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      UPDATE sessions
      SET created_at = created_at - make_interval(days => ${days}),
          last_seen_at = last_seen_at - make_interval(days => ${days}),
          expires_at = expires_at - make_interval(days => ${days}),
          absolute_expires_at = absolute_expires_at - make_interval(days => ${days})
      WHERE id = ${sessionId}`;
  });
}

export async function sessionRow(database: TestDatabase, accountId: string, sessionId: string): Promise<SessionRow> {
  const row = (await sessionRows(database, accountId)).find((candidate) => candidate.id === sessionId);
  if (row === undefined) {
    throw new Error("the session row is missing");
  }
  return row;
}

/** Records a password change at this instant: a session created before it is refused, one created after it is not. */
export async function markPasswordChangedNow(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET password_changed_at = clock_timestamp() WHERE id = ${accountId}`;
  });
}
