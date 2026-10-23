import type { Adapters, TenantResolution, TenantResolver } from "@slugbase/core";
import { isFixtureInstanceAdmin, isFixtureToken, PROBE_INSTANCE_ADMIN, type MatrixPrincipal, type TenantFixture, type TokenScope } from "@slugbase/testing/tenancy";
import type { ApiTokenPrincipal, Authenticator, ModuleContext, SessionPrincipal } from "../../src/create-server.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters } from "../support.ts";
import type { Credentials, PolicyHooks } from "./walker.ts";

// The stub principals of the contract tests. Until the sign-in and token
// modules exist there is no real credential to send, so the stub world gives
// the chain the two authenticators of stage 4 and the tenant resolver of stage
// 7 over the two-workspace fixture: a cookie `slugbase_stub=session:<account>`
// (a session that has not re-authenticated) or `slugbase_stub=fresh:<account>` (one that has, just now)
// and a bearer `stub-token.<scope>.<account>`. The chain above them (policy,
// scope, role, tenant) is the production code.

const COOKIE = "slugbase_stub";
const SESSION_COOKIE = new RegExp(`(?:^|;\\s*)${COOKIE}=(session|fresh):([^;\\s]+)`);
const BEARER_TOKEN = /^Bearer stub-token\.(read|read-write)\.(\S+)$/;

/** An account no workspace has a member of. */
export const OUTSIDER_ACCOUNT = "0192f3a0-0000-7000-8000-00000000d001";
/** An account that administers the instance and belongs to no workspace. */
export const INSTANCE_ADMIN_ACCOUNT = PROBE_INSTANCE_ADMIN.accountId;

export interface StubWorld {
  /** The authenticators a test module registers (`ModuleContribution.authenticators`). */
  readonly authenticators: readonly Authenticator[];
  /** The adapters of the server under test: unconfigured ports, the in-memory rate limiter and the stub tenant resolver. */
  adapters(config?: ModuleContext["config"]): Adapters;
  readonly hooks: PolicyHooks;
  /** The second-factor check of the server under test: only the instance admin of the stub world has a second factor enrolled. */
  readonly secondFactor: (subject: { readonly accountId: string }) => Promise<boolean>;
  /** What a fixture principal sends: its session cookie, or for a token its bearer header. */
  credentialsOf(principal: MatrixPrincipal): Credentials;
  /** A bearer token of the given scope, of the owner of workspace A. */
  tokenOf(scope: TokenScope): Credentials;
}

function sessionCredentials(accountId: string): Credentials {
  return { headers: { cookie: `${COOKIE}=session:${accountId}` } };
}

/** A session that re-authenticated just now, so the operations that declare re-authentication get as far as their handlers. */
function freshSessionCredentials(accountId: string): Credentials {
  return { headers: { cookie: `${COOKIE}=fresh:${accountId}` } };
}

function tokenCredentials(scope: TokenScope, accountId: string): Credentials {
  return { headers: { authorization: `Bearer stub-token.${scope}.${accountId}` } };
}

export function createStubWorld(fixture: TenantFixture): StubWorld {
  const memberships = new Map<string, TenantResolution>();
  for (const workspace of [fixture.a, fixture.b]) {
    for (const [role, principal] of [["owner", workspace.owner], ["admin", workspace.admin], ["member", workspace.member]] as const) {
      memberships.set(principal.accountId, { workspaceId: workspace.id, memberId: principal.accountId, role });
    }
  }

  const cookie: Authenticator = {
    credential: "cookie",
    authenticate: (header): Promise<SessionPrincipal | undefined> => {
      const match = SESSION_COOKIE.exec(header);
      const accountId = match?.[2];
      if (accountId === undefined) {
        return Promise.resolve(undefined);
      }
      const membership = memberships.get(accountId);
      return Promise.resolve({
        kind: "session",
        sessionId: `stub-session-${accountId}`,
        accountId,
        activeWorkspaceId: membership?.workspaceId,
        instanceAdmin: accountId === INSTANCE_ADMIN_ACCOUNT,
        ...(match?.[1] === "fresh" ? { reauthAt: new Date() } : {}),
      });
    },
  };
  const bearer: Authenticator = {
    credential: "bearer",
    authenticate: (header): Promise<ApiTokenPrincipal | undefined> => {
      const match = BEARER_TOKEN.exec(header);
      const scope = match?.[1];
      const accountId = match?.[2];
      const membership = accountId === undefined ? undefined : memberships.get(accountId);
      if ((scope !== "read" && scope !== "read-write") || accountId === undefined || membership === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ kind: "api-token", tokenId: `token-${accountId}`, accountId, workspaceId: membership.workspaceId, scope });
    },
  };

  const resolver: TenantResolver = {
    available: true,
    resolve: (principal) => {
      const membership = memberships.get(principal.accountId);
      const bound = principal.kind === "api-token" ? principal.workspaceId : principal.activeWorkspaceId;
      return Promise.resolve(membership !== undefined && membership.workspaceId === bound ? membership : undefined);
    },
  };

  const owner = sessionCredentials(fixture.a.owner.accountId);
  const authorized = (policy: string): Credentials => (policy === "instanceAdmin" ? sessionCredentials(INSTANCE_ADMIN_ACCOUNT) : owner);
  const justBelow: Readonly<Record<string, string>> = {
    member: OUTSIDER_ACCOUNT,
    admin: fixture.a.member.accountId,
    owner: fixture.a.admin.accountId,
    // A session of the workspace owner, who is not an instance admin.
    instanceAdmin: fixture.a.owner.accountId,
  };

  return {
    authenticators: [cookie, bearer],
    secondFactor: ({ accountId }) => Promise.resolve(accountId === INSTANCE_ADMIN_ACCOUNT),
    adapters: (config) => ({ ...adapters(config), tenantResolver: resolver, secretBox: testSecretBox(testKey("walker-1")) }),
    credentialsOf: (principal) =>
      !isFixtureInstanceAdmin(principal) && isFixtureToken(principal) ? tokenCredentials(principal.scope, principal.accountId) : freshSessionCredentials(principal.accountId),
    tokenOf: (scope) => tokenCredentials(scope, fixture.a.owner.accountId),
    hooks: {
      authorized: (operation) => authorized(operation.auth),
      // The `session:` stub sessions carry no re-authentication, so every one of them is a session that has none; the sessions of the matrix are fresh ones.
      withoutReauth: (operation) => authorized(operation.auth),
      tooLowRole: (operation) => {
        // The account just below the policy: a role below it, no workspace at all below `member` (answered 404), a non-admin below `instanceAdmin`.
        const account = Object.hasOwn(justBelow, operation.auth) ? justBelow[operation.auth] : undefined;
        return account === undefined ? undefined : sessionCredentials(account);
      },
      readOnlyToken: () => tokenCredentials("read", fixture.a.owner.accountId),
      // The server composes no entitlement source: every entitlement is refused, whoever asks.
      withoutEntitlement: (operation) => authorized(operation.auth),
      workspaceA: (operation) => authorized(operation.auth),
    },
  };
}
