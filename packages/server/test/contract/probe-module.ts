import { defineOperation, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import { identifiersOf, type Probe } from "@slugbase/testing/tenancy";
import { z } from "zod";
import type { ChainContext, RequestTenant, ServerModule } from "../../src/create-server.ts";
import { ProblemError } from "../../src/http/problem.ts";
import { route } from "../../src/routes/register.ts";
import type { ContractFixtures } from "./walker.ts";
import type { StubWorld } from "./stubs.ts";

// The test module of the contract tests: operations over the probe table of the
// cross-tenant fixture, one for each policy the walker's hooks act on. Phase 1
// declares no operation that needs a principal, so the module is how the hooks
// run before one exists. Its document is built here from the same declarations;
// its handlers read through the scoped repository methods and the tenant
// transaction of the request.

const forbidden = problemResponse("The principal may not call the operation");
const unauthenticated = problemResponse("No credential was accepted");
const notFound = problemResponse("The row is not visible to the caller");

const RowSchema = z.strictObject({ id: z.uuid(), label: z.string() });
const RowParams = z.strictObject({ rowId: z.uuid() });

export const getProbeRow = defineOperation({
  method: "get",
  path: "/api/v1/probe-rows/{rowId}",
  operationId: "getProbeRow",
  tag: "probe",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { params: RowParams },
  responses: { 200: jsonResponse("The row", RowSchema), 401: unauthenticated, 403: forbidden, 404: notFound },
});

export const checkProbeRow = defineOperation({
  method: "post",
  path: "/api/v1/probe-rows/{rowId}/check",
  operationId: "checkProbeRow",
  tag: "probe",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: RowParams, body: z.strictObject({ label: z.string() }) },
  responses: {
    200: jsonResponse("Whether the stored label is the one sent", z.strictObject({ id: z.uuid(), matches: z.boolean() })),
    401: unauthenticated,
    403: forbidden,
    404: notFound,
    422: problemResponse("The body did not pass validation"),
  },
});

export const getProbeAdminRow = defineOperation({
  method: "get",
  path: "/api/v1/probe-admin-rows/{rowId}",
  operationId: "getProbeAdminRow",
  tag: "probe",
  auth: "admin",
  rate: "read",
  scope: "read",
  request: { params: RowParams },
  responses: { 200: jsonResponse("The row", RowSchema), 401: unauthenticated, 403: forbidden, 404: notFound },
});

const WorkspaceSchema = z.strictObject({ workspaceId: z.uuid() });

export const getProbeSettings = defineOperation({
  method: "get",
  path: "/api/v1/probe-settings",
  operationId: "getProbeSettings",
  tag: "probe",
  auth: "admin",
  rate: "read",
  scope: "read",
  responses: { 200: jsonResponse("The workspace", WorkspaceSchema), 401: unauthenticated, 403: forbidden },
});

export const getProbeOwnership = defineOperation({
  method: "get",
  path: "/api/v1/probe-ownership",
  operationId: "getProbeOwnership",
  tag: "probe",
  auth: "owner",
  rate: "read",
  scope: "read",
  responses: { 200: jsonResponse("The workspace", WorkspaceSchema), 401: unauthenticated, 403: forbidden },
});

export const getProbeInstance = defineOperation({
  method: "get",
  path: "/api/v1/probe-instance",
  operationId: "getProbeInstance",
  tag: "probe",
  auth: "instanceAdmin",
  rate: "read",
  responses: { 200: jsonResponse("The instance", z.strictObject({ ok: z.literal(true) })), 401: unauthenticated, 403: forbidden },
});

export const getProbePremium = defineOperation({
  method: "get",
  path: "/api/v1/probe-premium",
  operationId: "getProbePremium",
  tag: "probe",
  auth: "member",
  rate: "read",
  scope: "read",
  entitlement: "probe.premium",
  responses: { 200: jsonResponse("The feature", z.strictObject({ ok: z.literal(true) })), 401: unauthenticated, 403: forbidden },
});

export const getProbeMe = defineOperation({
  method: "get",
  path: "/api/v1/probe-me",
  operationId: "getProbeMe",
  tag: "probe",
  auth: "account",
  rate: "read",
  scope: "read",
  responses: { 200: jsonResponse("The account", z.strictObject({ accountId: z.uuid() })), 401: unauthenticated },
});

export const probeOperations: readonly OperationDefinition[] = [
  getProbeRow,
  checkProbeRow,
  getProbeAdminRow,
  getProbeSettings,
  getProbeOwnership,
  getProbeInstance,
  getProbePremium,
  getProbeMe,
];

function isRow(value: unknown): value is { id: string; label: string } {
  return typeof value === "object" && value !== null && "id" in value && "label" in value && typeof value.id === "string" && typeof value.label === "string";
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new Error("the operation was reached without a tenant");
  }
  return tenant;
}

/** The module: the stub authenticators of the world and a route for each probe operation. */
export function probeModule(probe: Probe, world: StubWorld): ServerModule {
  const select = probe.methods.find((entry) => entry.method === "select");
  if (select === undefined) {
    throw new Error("the probe has no select method");
  }
  /** The row of the caller's workspace; the scoped repository reads only that workspace's rows. */
  const rowOf = async (context: ChainContext, id: string): Promise<{ id: string; label: string }> => {
    const rows = await tenantOf(context).withTenant((tx) => select.invoke(tx));
    const row = rows.filter(isRow).find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new ProblemError("not_found", "No such row.");
    }
    return row;
  };
  const workspace = (_request: unknown, context: ChainContext): { status: 200; body: { workspaceId: string } } => ({
    status: 200,
    body: { workspaceId: tenantOf(context).workspaceId },
  });

  return {
    name: "probe",
    register: () => ({
      authenticators: world.authenticators,
      routes: [
        route(getProbeRow).handle(async ({ params }, context) => {
          const { id, label } = await rowOf(context, params.rowId);
          return { status: 200, body: { id, label } };
        }),
        route(checkProbeRow).handle(async ({ params, body }, context) => {
          const row = await rowOf(context, params.rowId);
          return { status: 200, body: { id: row.id, matches: row.label === body.label } };
        }),
        route(getProbeAdminRow).handle(async ({ params }, context) => {
          const { id, label } = await rowOf(context, params.rowId);
          return { status: 200, body: { id, label } };
        }),
        route(getProbeSettings).handle(workspace),
        route(getProbeOwnership).handle(workspace),
        route(getProbeInstance).handle(() => ({ status: 200, body: { ok: true } })),
        route(getProbePremium).handle(() => ({ status: 200, body: { ok: true } })),
        route(getProbeMe).handle((_request, context) => {
          const principal = context.get("principal");
          if (principal === undefined) {
            throw new Error("the operation was reached without a principal");
          }
          return { status: 200, body: { accountId: principal.accountId } };
        }),
      ],
    }),
  };
}

/**
 * The fixtures of the probe operations: a row of workspace A for the valid
 * request and a row of workspace B for the foreign one. The premium operation
 * answers its entitlement refusal to a valid request, because the server
 * composes no entitlement source.
 */
export function probeFixtures(probe: Probe): ContractFixtures {
  const rowIn = (workspace: Probe["fixture"]["a"]): string => {
    const row = identifiersOf(workspace, "bookmark")[0];
    if (row === undefined) {
      throw new Error("the probe fixture holds no row");
    }
    return row.id;
  };
  const own = { rowId: rowIn(probe.fixture.a) };
  const foreign = { rowId: rowIn(probe.fixture.b) };
  const body = { label: "matrix-probe-a-shared" };
  return {
    getProbeRow: { path: own, foreign: { path: foreign } },
    checkProbeRow: { path: own, body, foreign: { path: foreign, body } },
    getProbeAdminRow: { path: own, foreign: { path: foreign } },
    getProbeSettings: {},
    getProbeOwnership: {},
    getProbeInstance: {},
    getProbePremium: { status: 403 },
    getProbeMe: {},
  };
}
