import { generateApiToken, type MailPort } from "@slugbase/core";
import { apiTokenRepository, type AuthStore } from "@slugbase/db";
import type { TestDatabase } from "@slugbase/testing/db";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Logger, type Server } from "../../src/create-server.ts";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// The fixtures of the workspace authorization suites: a server over the migrated test database, people who are
// signed in and have re-authenticated, and workspaces with members of the roles a test names. The suites share
// them because both judge the same operations through the same chain.

export const WORKSPACE = "/api/v1/workspace";
export const WORKSPACES = "/api/v1/workspaces";
export const MEMBERS = "/api/v1/members";
export const SETTINGS = "/api/v1/workspace/settings";
export const LEAVE = "/api/v1/workspace/leave";
export const TRANSFER = "/api/v1/workspace/transfer-ownership";
export const ACTIVE_WORKSPACE = "/api/v1/session/active-workspace";
export const REAUTH = "/api/v1/me/reauth";
export const SESSION_COOKIE = "__Host-slugbase_session";
export const HOOK_TIMEOUT_MS = 300_000;

export type Role = "owner" | "admin" | "member";

export interface World {
  readonly server: Server;
  readonly origin: string;
}

export interface Person {
  readonly account: SeededAccount;
  /** The cookie header of a full session. */
  readonly cookie: string;
  readonly sessionId: string;
}

export interface Workspace {
  readonly workspaceId: string;
  readonly members: ReadonlyMap<string, Role>;
}

export function only<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error("no such item");
  }
  return item;
}

export const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` });

export function send(world: World, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { origin: world.origin, "content-type": "application/json", ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), init));
}

export interface WorkspaceHarness {
  /** Migrates the test database and opens the auth store; the `beforeAll` of a suite. */
  start(): Promise<void>;
  /** Closes the auth store; the `afterAll` of a suite. */
  stop(): Promise<void>;
  serve(options?: {
    readonly allowWorkspaceCreation?: boolean;
    readonly entitlements?: EntitlementCheck;
    readonly mail?: MailPort;
    /** Configuration keys that replace the suite's defaults. */
    readonly env?: Record<string, string>;
    /** Records what the server logs; by default a logger nobody reads. */
    readonly logger?: Logger;
  }): World;
  /** A verified account with a session that re-authenticated just now. */
  person(world: World): Promise<Person>;
  /** Re-authenticates the person's session, which moves the ten-minute window of the operations that ask for it. */
  reauthenticate(world: World, person: Person): Promise<void>;
  /** A workspace, its settings row, and the given people as members of the roles given, with every session of theirs acting in it. */
  workspaceOf(members: readonly { readonly person: Pick<Person, "account">; readonly role: Role }[]): Promise<Workspace>;
  /** An API token of the person for the workspace, minted the way creating one does; the value is the credential a client sends. */
  token(workspaceId: string, person: Person, scope: "read" | "read-write"): Promise<string>;
  rolesOf(workspaceId: string): Promise<Record<string, string>>;
  /** The actions of the workspace's audit events, oldest first. */
  auditActions(workspaceId: string): Promise<string[]>;
}

export function workspaceHarness(database: () => TestDatabase): WorkspaceHarness {
  let store: AuthStore | undefined;
  let tokenNumber = 0;

  const authStore = (): AuthStore => {
    if (store === undefined) {
      throw new Error("the harness is not started");
    }
    return store;
  };

  async function reauthenticate(world: World, person: Person): Promise<void> {
    const response = await send(world, "POST", REAUTH, { cookie: person.cookie }, { password: person.account.password });
    if (response.status !== 204) {
      throw new Error(`could not re-authenticate: ${String(response.status)}`);
    }
  }

  return {
    async start() {
      store = storeFor(database());
      // The queues the operations write to exist once the image entrypoint has run migrate.
      await runMigrations({ url: urlOf(database().owner) });
    },
    async stop() {
      await store?.close();
    },
    serve(options = {}) {
      const config = serverConfig({
        NODE_ENV: "test",
        DATABASE_URL: appUrl(database()),
        RATE_LIMIT_LOGIN_IP: "10000/min",
        RATE_LIMIT_LOGIN_EMAIL: "10000/hour",
        RATE_LIMIT_WRITE_IP: "10000/min",
        RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
        RATE_LIMIT_READ_IP: "10000/min",
        RATE_LIMIT_READ_ACCOUNT: "10000/min",
        RATE_LIMIT_MFA_IP: "10000/min",
        RATE_LIMIT_MFA_ACCOUNT: "10000/hour",
        ...options.env,
      });
      const server = createServer({
        config,
        adapters: { ...adapters(config), ...(options.mail === undefined ? {} : { mail: options.mail }), tenantResolver: createAccountOnlyTenantResolver() },
        modules: [],
        migrations: [],
        logger: options.logger ?? recordingLogger(),
        database: tenantDatabase(database()),
        authStore: authStore(),
        ...(options.allowWorkspaceCreation === undefined ? {} : { allowWorkspaceCreation: options.allowWorkspaceCreation }),
        ...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
      });
      return { server, origin: config.APP_ORIGIN };
    },
    async person(world) {
      const account = await seedAccount(database(), { emailVerified: true });
      const response = await send(world, "POST", "/api/v1/auth/login", {}, { email: account.email, password: account.password, remember: false });
      const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
      if (response.status !== 200 || token === undefined) {
        throw new Error(`could not sign in: ${String(response.status)}`);
      }
      const sessionId = (await sessionRows(database(), account.id))[0]?.id;
      if (sessionId === undefined) {
        throw new Error("the account has no session");
      }
      const person = { account, cookie: `${SESSION_COOKIE}=${token}`, sessionId };
      await reauthenticate(world, person);
      return person;
    },
    reauthenticate,
    async workspaceOf(members) {
      const workspaceId = await seedWorkspace(database(), { name: "Authorization suite" });
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
      });
      for (const { person, role } of members) {
        await seedMembership(database(), { workspaceId, accountId: person.account.id, role });
        for (const session of await sessionRows(database(), person.account.id)) {
          await setActiveWorkspace(database(), session.id, workspaceId);
        }
      }
      return { workspaceId, members: new Map(members.map(({ person, role }) => [person.account.id, role])) };
    },
    async token(workspaceId, person, scope) {
      tokenNumber += 1;
      const token = generateApiToken();
      const outcome = await tenantDatabase(database()).withTenant({ accountId: person.account.id, requestId: "workspace-suite-token" }, (tx) =>
        apiTokenRepository(tx).create({
          id: `0192f3a0-aaab-7000-8000-${tokenNumber.toString(16).padStart(12, "0")}`,
          workspaceId,
          name: `suite token ${String(tokenNumber)}`,
          scope,
          tokenHash: token.hash,
          tokenPrefix: token.displayPrefix,
          expiresInDays: 90,
          limit: Number.MAX_SAFE_INTEGER,
        }),
      );
      if (outcome.kind !== "created") {
        throw new Error(`the token could not be minted: ${outcome.kind}`);
      }
      return token.value;
    },
    async rolesOf(workspaceId) {
      const rows = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      });
      return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
    },
    async auditActions(workspaceId) {
      const rows = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ action: string }[]>`SELECT action FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
      });
      return rows.map((row) => row.action);
    },
  };
}
