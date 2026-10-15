import type { FixtureIdentifier, FixturePrincipal, FixtureToken, PrincipalRole, TenantFixture, WorkspaceFixture } from "../../src/tenancy.ts";

// A two-workspace fixture held in memory, for the tests of the runner itself:
// the checksum is a counter the stubs can bump to stand for a changed row.

export const A_ID = "0192f3a0-1111-7000-8000-0000000000a1";
export const B_ID = "0192f3a0-1111-7000-8000-0000000000b1";
export const B_BOOKMARK_SHARED = "0192f3a0-2222-7000-8000-0000000000b2";
export const B_BOOKMARK_UNSHARED = "0192f3a0-2222-7000-8000-0000000000b3";
export const B_TEAM = "0192f3a0-3333-7000-8000-0000000000b4";
export const B_MEMBER = "0192f3a0-0000-7000-8000-0000000000b5";
export const B_MARKER = "quarterly-plan-of-b";

function principal(side: string, role: PrincipalRole): FixturePrincipal {
  const accountId = `0192f3a0-0000-7000-8000-${side}-${role}`.padEnd(36, "0").slice(0, 36);
  return { role, accountId, credentials: `session:${accountId}` };
}

/** A token of each role and scope of workspace A, which the fixture is asked for with `withTokens`. */
function tokens(side: string): FixtureToken[] {
  return (["owner", "admin", "member"] as const).flatMap((role) =>
    (["read", "read-write"] as const).map((scope) => ({ ...principal(side, role), scope, credentials: `token:${scope}:${role}` })),
  );
}

function workspace(side: string, id: string, identifiers: readonly FixtureIdentifier[], markers: string[]): WorkspaceFixture {
  return {
    id,
    owner: principal(side, "owner"),
    admin: principal(side, "admin"),
    member: principal(side, "member"),
    identifiers,
    markers,
  };
}

export interface MemoryFixture extends TenantFixture {
  /** Stands for a write to one of B's rows. */
  touchB(): void;
}

export function memoryFixture({ withTokens = false }: { withTokens?: boolean } = {}): MemoryFixture {
  let version = 0;
  return {
    a: { ...workspace("a", A_ID, [{ kind: "workspace", id: A_ID }], ["marker-of-a"]), ...(withTokens ? { tokens: tokens("a") } : {}) },
    b: workspace(
      "b",
      B_ID,
      [
        { kind: "workspace", id: B_ID },
        { kind: "bookmark", id: B_BOOKMARK_SHARED, visibility: "shared" },
        { kind: "bookmark", id: B_BOOKMARK_UNSHARED, visibility: "unshared" },
        { kind: "team", id: B_TEAM },
        { kind: "member", id: B_MEMBER },
      ],
      [B_MARKER],
    ),
    checksum: (workspaceId) => Promise.resolve(`${workspaceId}:${String(version)}`),
    touchB() {
      version += 1;
    },
  };
}

interface OperationSpec {
  operationId: string;
  method?: string;
  path: string;
  auth: string | undefined;
  parameters?: unknown[];
  requestBody?: unknown;
  /** The `x-slugbase-scope` extension. */
  scope?: string;
  reauth?: boolean;
}

/** An OpenAPI document with the given operations, each carrying the policy extension. */
export function documentOf(operations: readonly OperationSpec[], components?: unknown): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const item = (paths[operation.path] ??= {});
    item[operation.method ?? "get"] = {
      operationId: operation.operationId,
      ...(operation.auth === undefined ? {} : { "x-slugbase-auth": operation.auth }),
      ...(operation.scope === undefined ? {} : { "x-slugbase-scope": operation.scope }),
      ...(operation.reauth === undefined ? {} : { "x-slugbase-reauth": operation.reauth }),
      ...(operation.parameters === undefined ? {} : { parameters: operation.parameters }),
      ...(operation.requestBody === undefined ? {} : { requestBody: operation.requestBody }),
      responses: { "200": { description: "ok" } },
    };
  }
  return { openapi: "3.1.0", paths, ...(components === undefined ? {} : { components }) };
}
