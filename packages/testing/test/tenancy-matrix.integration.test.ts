import { bookmarkRepository, listRepositoryMethods, TenantContextError, type RepositoryMethodEntry } from "@slugbase/db";
import type { TestDatabase } from "@slugbase/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "../src/db.ts";
import {
  assertMatrixPassed,
  classifyOperations,
  createProbe,
  loadOpenApiDocument,
  PROBE_INSTANCE_ADMIN,
  PROBE_WORKSPACE_A,
  PROBE_WORKSPACE_B,
  runApiMatrix,
  runRlsOnlyMatrix,
  type ApiCall,
  type ApiResponse,
  type MatrixFailure,
  type Probe,
  type TenantFixture,
} from "../src/tenancy.ts";

// The cross-tenant matrix (doc 08 section 3.3, D8, T1, T2). The first suite
// runs it over the committed contract and the scoped-repository registry as
// they are; the others prove it can fail, against a probe table whose policy
// is wrong and against handlers that break the boundary.

const HOOK_TIMEOUT_MS = 300_000;

/**
 * The rows a table that references the workspace needs: the fixture names the two workspaces but creates only the probe table. Each workspace gets a
 * bookmark, so that a read of the bookmarks without a predicate has a row of B to leak.
 */
async function seedWorkspaceRows(database: TestDatabase, workspaces: readonly { readonly id: string; readonly bookmarkId: string }[]): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    for (const { id, bookmarkId } of workspaces) {
      await tx`INSERT INTO workspaces (id, name) VALUES (${id}, 'Matrix workspace') ON CONFLICT DO NOTHING`;
      await tx`
        INSERT INTO bookmarks (id, workspace_id, url, url_canonical, host, title)
        VALUES (${bookmarkId}, ${id}, 'https://example.com/matrix-seed', 'https://example.com/matrix-seed', 'example.com', 'matrix-bookmark-seed') ON CONFLICT DO NOTHING`;
    }
  });
}

/**
 * The tags the RLS-only mode runs against: a tag is its owner's, so the owner of A has an account, a membership and a tag in A (the update and the
 * delete of the registry touch it), and the owner of B has the same in B (the tag the methods must not reach).
 */
async function seedTagRows(database: TestDatabase, fixture: TenantFixture): Promise<void> {
  const sides = [
    { workspaceId: fixture.a.id, owner: fixture.a.owner.accountId, email: "matrix-tag-a@example.test", tagId: "0192f3a0-2222-7000-8000-00000000a0c1" },
    { workspaceId: fixture.b.id, owner: fixture.b.owner.accountId, email: "matrix-tag-b@example.test", tagId: "0192f3a0-2222-7000-8000-00000000b0c1" },
  ];
  for (const { owner, email } of sides) {
    await database.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${owner}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${owner}, ${email}, 'Matrix tag owner') ON CONFLICT DO NOTHING`;
    });
  }
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    for (const { workspaceId, owner, tagId } of sides) {
      await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceId}, ${owner}, 'owner') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${tagId}, ${workspaceId}, ${owner}, 'matrix-tag-seed') ON CONFLICT DO NOTHING`;
    }
  });
}

/**
 * The folders the RLS-only mode runs against. The policies of `folders` name the workspace only, so the update and the delete of the registry,
 * which have no predicate, touch every folder of A: A holds one, and B holds the folder the methods must not reach. Both are ownerless, as the row
 * of the folders sample's insert is.
 */
async function seedFolderRows(database: TestDatabase, fixture: TenantFixture): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO folders (id, workspace_id, name) VALUES ('0192f3a0-2222-7000-8000-00000000a0d1', ${fixture.a.id}, 'matrix-folder-seed') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO folders (id, workspace_id, name) VALUES ('0192f3a0-2222-7000-8000-00000000b0d1', ${fixture.b.id}, 'matrix-folder-seed') ON CONFLICT DO NOTHING`;
  });
}

/**
 * The links the RLS-only mode runs against: a link is its owner's on both sides, so the owner of A (whose account and membership `seedTagRows` made) owns
 * a folder and two bookmarks in A, one of them linked to the folder, which the delete of the registry removes and the insert of the sample leaves in place
 * (the sample links the other); the owner of B has the same in B, the link the methods must not reach.
 */
async function seedLinkRows(database: TestDatabase, fixture: TenantFixture): Promise<void> {
  const sides = [
    { workspaceId: fixture.a.id, owner: fixture.a.owner.accountId, folder: "0192f3a0-2222-7000-8000-00000000a0d2", free: "0192f3a0-2222-7000-8000-00000000a0b2", linked: "0192f3a0-2222-7000-8000-00000000a0b3" },
    { workspaceId: fixture.b.id, owner: fixture.b.owner.accountId, folder: "0192f3a0-2222-7000-8000-00000000b0d2", free: "0192f3a0-2222-7000-8000-00000000b0b2", linked: "0192f3a0-2222-7000-8000-00000000b0b3" },
  ];
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    for (const { workspaceId, owner, folder, free, linked } of sides) {
      await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folder}, ${workspaceId}, ${owner}, 'matrix-link-folder') ON CONFLICT DO NOTHING`;
      for (const bookmark of [free, linked]) {
        await tx`
          INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
          VALUES (${bookmark}, ${workspaceId}, ${owner}, 'https://example.com/matrix-link', 'https://example.com/matrix-link', 'example.com', 'matrix-link-bookmark') ON CONFLICT DO NOTHING`;
      }
      await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folder}, ${linked}) ON CONFLICT DO NOTHING`;
    }
  });
}

const database = useTestDatabase();
let scoped: Probe;
let permissive: Probe;
// The tests that write to B get a table of their own.
let victim: Probe;

beforeAll(async () => {
  scoped = await createProbe(database(), { table: "matrix_probe", repository: "matrix_probe" });
  permissive = await createProbe(database(), { table: "matrix_probe_open", repository: "matrix_probe_open", policy: "permissive" });
  victim = await createProbe(database(), { table: "matrix_probe_victim", repository: "matrix_probe_victim" });
}, HOOK_TIMEOUT_MS);

const document = loadOpenApiDocument();
const classification = classifyOperations(document);

describe("the matrix over the committed contract and the repository registry", () => {
  // This package-level test exercises the runner with no server. The API mode
  // over the real middleware chain, through an in-process createServer, runs in
  // packages/server/test/contract/ (matrixRequest), where the answers are held
  // to account. Here a fixed responder stands in for the server, so what the
  // test proves is the runner's own part: the classification of the document
  // and that every tenant-scoped operation is called by every principal of A,
  // the operations that name a member of B (the role change, the ownership transfer, the removal and the leaving) once for each member of B. The responder answers as the
  // chain does for a member of B: 403 to a token of an operation that declares no scope, or the write scope when the token may only read (the bookmark read takes
  // a token of either scope), to a plain member where the policy is the admin's (the leaving and the bookmark read are a member's) and to an admin where it is the
  // owner's (the ownership transfer), 404 to the rest. The invitation names a team of B in its body, and the
  // server refuses any team with 422 because no team can be invited into yet and none can be told from another, so the responder gives an admin and
  // an owner session that answer (the member and the tokens are refused with 403 before the handler).
  const answersAsTheChainDoes = (call: ApiCall): Promise<ApiResponse> => {
    if (call.operation.operationId === "createInvitation" && !("scope" in call.principal) && call.principal.role !== "member") {
      return Promise.resolve({ status: 422 });
    }
    const tokenRefused = "scope" in call.principal && (call.operation.scope === undefined || (call.operation.scope === "write" && call.principal.scope !== "read-write"));
    return Promise.resolve({
      status:
        tokenRefused ||
        (call.principal.role === "member" && call.operation.policy !== "member") ||
        (call.principal.role === "admin" && call.operation.policy === "owner")
          ? 403
          : 404,
    });
  };

  it(`API mode classifies the ${String(classification.summary.total)} operations of openapi.json and calls each tenant-scoped one once for every principal of A`, async () => {
    // The probe fixture holds no team and no invitation, so workspace B is given one of each: the matrix puts the team in the invitation's `teamIds`
    // and the invitation in the path of the operations that resend, link and revoke one.
    const fixture = {
      ...scoped.fixture,
      b: {
        ...scoped.fixture.b,
        identifiers: [
          ...scoped.fixture.b.identifiers,
          { kind: "team" as const, id: "0192f3a0-cccc-7000-8000-000000000005" },
          { kind: "invitation" as const, id: "0192f3a0-cccc-7000-8000-000000000007" },
        ],
      },
    };
    const matrix = await runApiMatrix({ document, fixture, request: answersAsTheChainDoes, mapping: { accountId: "member", transferTo: "member", "teamIds[]": "team", id: "invitation", "getBookmark.id": "bookmark", "updateBookmark.id": "bookmark", "deleteBookmark.id": "bookmark", "openBookmark.id": "bookmark", "renameTag.id": "tag", "deleteTag.id": "tag", "getFolder.id": "folder", "updateFolder.id": "folder", "deleteFolder.id": "folder", "addFolderBookmarks.id": "folder", "removeFolderBookmarks.id": "folder", "addFolderBookmarks.bookmarkIds[]": "bookmark", "removeFolderBookmarks.bookmarkIds[]": "bookmark", "listBookmarks.folderId": "folder", "createBookmark.folderIds[]": "folder", "updateBookmark.folderIds[]": "folder", "listBookmarks.hasSlug": "bookmark", "listBookmarkIds.hasSlug": "bookmark", "bulkBookmarks.ids[]": "bookmark", "bulkBookmarks.filter.hasSlug": "bookmark" } });
    // The matrix expects 404 for an identifier of workspace B. The one exception is the 422 every team is refused with (see above), for the two sessions
    // of A that reach the handler of the invitation; it is named exactly, and every other failure stays one.
    const teamRefusal = (failure: MatrixFailure): boolean => failure.subject.startsWith("createInvitation ") && failure.kind === "unexpected_status" && /answered 422, expected 404/.test(failure.detail);
    expect(matrix.failures.filter(teamRefusal).map((failure) => failure.detail.slice(0, "as owner of A".length))).toEqual(["as owner of A", "as admin of A"]);
    const report = { ...matrix, failures: matrix.failures.filter((failure) => !teamRefusal(failure)) };
    expect(classification.problems).toEqual([]);
    expect(report.classified.total).toBe(classification.operations.length);
    expect(report.classified.total).toBeGreaterThan(0);
    expect(Object.values(report.classified.byKind).reduce((sum, count) => sum + count, 0)).toBe(report.classified.total);
    // The operations on /workspace (reading, renaming and deleting it), /workspace/settings, the entitlements, the members list, the creation of a bookmark (which the matrix calls once, with the one folder of B in `folderIds`), the creation and the list of tags and the creation and the list of folders act in the workspace of the request and take no identifier of B;
    // the role change, the ownership transfer and the removal name a member by account identifier, the removal and the leaving a recipient, the invitation a team,
    // the resend, the link and the revocation of an invitation name an invitation, and the bookmark read, change, deletion and open name a bookmark, as do the select-all and the bulk request in their inputs, and the rename and the deletion of a tag name a tag, and the read, the change and the deletion of a folder name a folder; the invitation list takes no identifier.
    expect(report.classified.byKind["tenant-scoped"]).toBe(35);
    // Three sessions and six tokens of A, once on each of the fourteen operations that name no member, once for each of the three members of B on the role
    // change, on the ownership transfer and on the leaving, once for each pair of members of B (path and recipient) on the removal, once for the
    // team of B on the invitation, once for the invitation of B on each of the resend, the link and the revocation, and once for each of the two
    // bookmarks of B on each of the bookmark read, change, deletion and open, and in the `hasSlug` filter of the bookmark list and of the select-all (picked by
    // its name), and once for each pair of a bookmark of B in `ids` and one in `filter.hasSlug` of the bulk request, and once for the tag of B on each of the rename and the deletion of a tag, and once for the folder of B on each of the read, the change and the deletion of a folder, and once for each of the two bookmarks of B with the folder of B on each of the filing and the unfiling of bookmarks.
    expect(report.attempts).toBe(9 * 14 + 9 * (3 + 3 + 3 + 3 * 3 + 3 + 4 * 2 + 2 + 2 + 2 * 2 + 2 + 3 + 2 * 2));
    assertMatrixPassed(report);
  });

  it("RLS-only mode passes over the scoped-repository registry as it stands", async () => {
    // The tables of the registry that reference the workspace (the bookmarks, the tags and the folders) need the two workspaces of the fixture to exist, and a row of each.
    await seedWorkspaceRows(database(), [
      { id: PROBE_WORKSPACE_A, bookmarkId: "0192f3a0-2222-7000-8000-00000000a0b1" },
      { id: PROBE_WORKSPACE_B, bookmarkId: "0192f3a0-2222-7000-8000-00000000b0b1" },
    ]);
    await seedTagRows(database(), scoped.fixture);
    await seedFolderRows(database(), scoped.fixture);
    await seedLinkRows(database(), scoped.fixture);
    const methods = listRepositoryMethods();
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: { ...scoped.fixture, instanceAdmin: PROBE_INSTANCE_ADMIN }, methods });
    expect(report.methods).toBe(methods.length);
    // the tags repository is in the registry with all four methods: the application role may insert, rename, delete and read a tag, and the policy keeps it to its owner's
    expect(methods.filter((entry) => entry.repository === "tags").map((entry) => entry.method).sort()).toEqual(["delete", "insert", "select", "update"]);
    // the folders repository is in the registry with all four methods: the application role may insert, change, delete and read a folder, and the policies keep it to the workspace
    expect(methods.filter((entry) => entry.repository === "folders").map((entry) => entry.method).sort()).toEqual(["delete", "insert", "select", "update"]);
    // the links repository is in the registry with the three methods the application role may run on the table: it reads, inserts the three columns of a link and deletes, and updates none
    expect(methods.filter((entry) => entry.repository === "folder_bookmarks").map((entry) => entry.method)).toEqual(["select", "insert", "delete"]);
    // the bookmarks repository is in the registry with the three methods the application role may run on the table, and no other: a delete is a system operation
    expect(methods.filter((entry) => entry.repository === "bookmarks").map((entry) => entry.method)).toEqual(["select", "insert", "update"]);
    // every method ran once more as the instance admin of the fixture, which belongs to neither workspace
    expect(report.instanceAdminAttempts).toBeGreaterThanOrEqual(methods.length);
    assertMatrixPassed(report);
  });
});

describe("RLS-only mode", () => {
  it("passes for a table with a workspace policy: every read and write stays in workspace A", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.methods).toBe(4);
    // select, delete, and an insert and an update each in A and naming B
    expect(report.attempts).toBe(6);
  });

  it("leaves the rows of A and B as it found them", async () => {
    const before = await Promise.all([scoped.fixture.checksum(PROBE_WORKSPACE_A), scoped.fixture.checksum(PROBE_WORKSPACE_B)]);
    await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    const after = await Promise.all([scoped.fixture.checksum(PROBE_WORKSPACE_A), scoped.fixture.checksum(PROBE_WORKSPACE_B)]);
    expect(after).toEqual(before);
  });

  it("fails for a table whose policy is USING (true)", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: permissive.fixture,
      methods: permissive.methods,
      samples: { [permissive.repository]: permissive.sample },
    });
    const byMethod = new Map(report.failures.map((failure) => [failure.subject.split(" ")[0], failure.kind]));
    expect(byMethod.get("matrix_probe_open.select")).toBe("read_foreign_row");
    // An update and a delete without the workspace predicate reach the rows of B.
    expect(byMethod.get("matrix_probe_open.update")).toBe("wrote_foreign_row");
    expect(byMethod.get("matrix_probe_open.delete")).toBe("wrote_foreign_row");
    // The RLS-only build neither stamps nor refuses an insert naming B: it reaches
    // the table, and the USING (true) WITH CHECK (true) policy lets it in.
    expect(byMethod.get("matrix_probe_open.insert")).toBe("wrote_foreign_row");
    expect(() => {
      assertMatrixPassed(report);
    }).toThrow(/rls-only.*matrix_probe_open\.select/s);
  });

  it("fails a USING (true) WITH CHECK (true) table on the insert naming B alone: the write reaches the table unchanged", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: permissive.fixture,
      methods: permissive.methods.filter((entry) => entry.method === "insert"),
      samples: { [permissive.repository]: permissive.sample },
    });
    expect(report.rlsRefusals).toBe(0);
    expect(report.applicationRefusals).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ kind: "wrote_foreign_row" });
    expect(report.failures[0]?.detail).toMatch(/^naming workspace B/);
  });

  it("reports the refusals of a table with a workspace policy as RLS evidence: the RLS-only build makes none of its own", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    // the insert and the update naming B, each refused by row-level security
    expect(report.rlsRefusals).toBe(2);
    expect(report.applicationRefusals).toEqual([]);
  });

  it("reports a method that refuses a write naming B with the foreign_workspace code as an application refusal, not as RLS evidence", async () => {
    const insert = methodOf(scoped, "insert");
    const entry: RepositoryMethodEntry = {
      ...insert,
      invokeRlsOnly: (tx, input) =>
        input?.values?.["workspaceId"] === PROBE_WORKSPACE_B
          ? Promise.reject(new TenantContextError("foreign_workspace", "refused"))
          : insert.invokeRlsOnly(tx, input),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.rlsRefusals).toBe(0);
    expect(report.applicationRefusals).toEqual(["matrix_probe.insert (matrix_probe)"]);
  });

  it("fails an update naming B that touches no row: row-level security was not exercised", async () => {
    const entry: RepositoryMethodEntry = {
      ...methodOf(scoped, "update"),
      invokeRlsOnly: (tx, input) =>
        input?.set?.["workspaceId"] === PROBE_WORKSPACE_B ? Promise.resolve([]) : methodOf(scoped, "update").invokeRlsOnly(tx, input),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["write_not_exercised"]);
    expect(report.failures[0]?.detail).toMatch(/^naming workspace B/);
  });

  it.each(["insert", "delete"] as const)(
    "fails a %s that changes the rows of B inside its transaction but returns no row: the rolled-back write is invisible to the checksum",
    async (name) => {
      const real = methodOf(permissive, name);
      const entry: RepositoryMethodEntry = {
        ...real,
        invokeRlsOnly: async (tx, input) => {
          await real.invokeRlsOnly(tx, input);
          return [];
        },
      };
      const report = await runRlsOnlyMatrix({
        tenant: database().tenant,
        fixture: permissive.fixture,
        methods: [entry],
        samples: { [permissive.repository]: permissive.sample },
      });
      expect(report.failures.map((failure) => failure.kind)).toEqual(Array(name === "delete" ? 1 : 2).fill("write_not_exercised"));
      expect(() => {
        assertMatrixPassed(report);
      }).toThrow(/write_not_exercised/);
    },
  );

  /** A real row-level-security refusal (SQLSTATE 42501): a row of B written under the transaction of A. */
  async function rowLevelSecurityRefusal(probe: Probe): Promise<Error> {
    try {
      await database().app.begin(async (sql) => {
        await sql`SELECT set_config('app.workspace_id', ${probe.fixture.a.id}, true)`;
        await sql.unsafe(`INSERT INTO ${probe.table} (id, workspace_id, label) VALUES ($1, $2, 'refused')`, [
          "0192f3a0-2222-7000-8000-00000000c0df",
          probe.fixture.b.id,
        ]);
      });
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === "42501") {
        return error;
      }
      throw error;
    }
    throw new Error("the database accepted a row of B under the transaction of A");
  }

  function methodOf(probe: Probe, name: RepositoryMethodEntry["method"]): RepositoryMethodEntry {
    const entry = probe.methods.find((candidate) => candidate.method === name);
    if (entry === undefined) {
      throw new Error(`the probe has no ${name} method`);
    }
    return entry;
  }

  it("counts a refusal by row-level security (42501) of a write naming B as a pass, and as RLS evidence", async () => {
    const insert = methodOf(scoped, "insert");
    const refused = await rowLevelSecurityRefusal(scoped);
    const entry: RepositoryMethodEntry = {
      ...insert,
      invokeRlsOnly: (tx, input) => (input?.values?.["workspaceId"] === PROBE_WORKSPACE_B ? Promise.reject(refused) : insert.invokeRlsOnly(tx, input)),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.rlsRefusals).toBe(1);
    expect(report.applicationRefusals).toEqual([]);
  });

  it("fails a write in workspace A that is refused, even by row-level security: the method did not run", async () => {
    const insert = methodOf(scoped, "insert");
    const refused = await rowLevelSecurityRefusal(scoped);
    const entry: RepositoryMethodEntry = { ...insert, invokeRlsOnly: () => Promise.reject(refused) };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures.map((failure) => `${failure.kind}: ${failure.detail.split(":")[0] ?? ""}`)).toEqual([
      "unexpected_error: in workspace A",
    ]);
  });

  it("fails an attempt naming B that the database rejects with a SQLSTATE other than 42501, though the attempt in A completes", async () => {
    const insert = methodOf(scoped, "insert");
    // Any other five-character SQLSTATE: 23505 (unique_violation) is a constraint, not row-level security.
    const rejected = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    const entry: RepositoryMethodEntry = {
      ...insert,
      invokeRlsOnly: (tx, input) => (input?.values?.["workspaceId"] === PROBE_WORKSPACE_B ? Promise.reject(rejected) : insert.invokeRlsOnly(tx, input)),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures.map((failure) => `${failure.kind}: ${failure.detail.split(":")[0] ?? ""}`)).toEqual([
      "unexpected_error: naming workspace B",
    ]);
    expect(report.rlsRefusals).toBe(0);
    expect(report.applicationRefusals).toEqual([]);
  });

  it("fails an insert the database rejects for another reason, on a USING (true) table", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: permissive.fixture,
      methods: permissive.methods.filter((entry) => entry.method === "insert"),
      samples: { [permissive.repository]: { ...permissive.sample, values: { id: "not-a-uuid", label: "matrix-probe-rejected" } } },
    });
    expect(report.failures.map((failure) => failure.kind)).toContain("unexpected_error");
    const own = report.failures.find((failure) => failure.detail.startsWith("in workspace A"));
    expect(own?.kind).toBe("unexpected_error");
    expect(own?.detail).toMatch(/uuid/i);
  });

  it.each(["insert", "update", "delete"] as const)(
    "fails a %s that throws a tenant-context error other than the foreign-workspace refusal, for every attempt",
    async (name) => {
      const entry: RepositoryMethodEntry = {
        ...methodOf(scoped, name),
        invokeRlsOnly: () => Promise.reject(new TenantContextError("not_a_tenant_transaction", "not a tenant transaction")),
      };
      const report = await runRlsOnlyMatrix({
        tenant: database().tenant,
        fixture: scoped.fixture,
        methods: [entry],
        samples: { [scoped.repository]: scoped.sample },
      });
      expect(report.failures.map((failure) => failure.kind)).toEqual(Array(name === "delete" ? 1 : 2).fill("unexpected_error"));
      expect(report.applicationRefusals).toEqual([]);
      expect(report.rlsRefusals).toBe(0);
    },
  );

  it("fails a read that throws instead of returning rows", async () => {
    const entry: RepositoryMethodEntry = {
      ...methodOf(scoped, "select"),
      invokeRlsOnly: () => Promise.reject(new TenantContextError("foreign_workspace", "refused")),
    };
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods: [entry] });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unexpected_error"]);
  });

  it("fails a write method whose repository has no sample row", async () => {
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods: scoped.methods, samples: {} });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unmapped_repository", "unmapped_repository"]);
    expect(report.failures[0]?.subject).toContain("matrix_probe.insert");
  });

  it("does not take an unexplained error for a refusal", async () => {
    const [select] = scoped.methods;
    if (select === undefined) {
      throw new Error("the probe has no methods");
    }
    const broken: RepositoryMethodEntry = {
      ...select,
      invokeRlsOnly: () => Promise.reject(new Error("connection lost")),
    };
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods: [broken] });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ kind: "unexpected_error" });
  });

  it("fails a method that changes B outside the transaction it was given", async () => {
    const [select] = victim.methods;
    if (select === undefined) {
      throw new Error("the probe has no methods");
    }
    const sneaky: RepositoryMethodEntry = {
      ...select,
      method: "delete",
      access: "write",
      invokeRlsOnly: async () => {
        await database().owner.begin(async (tx) => {
          await tx`SELECT set_config('app.workspace_id', ${PROBE_WORKSPACE_B}, true)`;
          await tx.unsafe(`UPDATE ${victim.table} SET label = 'tampered' WHERE workspace_id = $1`, [PROBE_WORKSPACE_B]);
        });
        return [{ workspaceId: PROBE_WORKSPACE_A }];
      },
    };
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: victim.fixture, methods: [sneaky] });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["workspace_changed"]);
  });
});

// The constructed Critical of doc 10 section 6: GET /api/bookmarks/{id} loads
// the row by id outside the tenant transaction, through a system operation
// that ignores the boundary, and answers an account of workspace A with a row
// of workspace B. Row-level security cannot see it, because the operation does
// not use the tenant transaction; the matrix in API mode has to.
describe("API mode over the probe table", () => {
  const READ_API = {
    openapi: "3.1.0",
    paths: { "/api/v1/bookmarks/{bookmarkId}": { get: { operationId: "getBookmark", "x-slugbase-auth": "member" } } },
  };
  const DELETE_API = {
    openapi: "3.1.0",
    paths: { "/api/v1/bookmarks/{bookmarkId}": { delete: { operationId: "deleteBookmark", "x-slugbase-auth": "member" } } },
  };
  const mapping = { bookmarkId: "bookmark" } as const;

  // The handlers below stand alone, with no chain in front of them to refuse a token that declares no scope; the probe's tokens
  // are exercised over the real chain in the contract tests of @slugbase/server.
  const sessionsOnly = (fixture: TenantFixture): TenantFixture => ({ ...fixture, a: { ...fixture.a, tokens: [] } });

  /** Runs `statement` as the table owner in workspace A and then in B until a row comes back: a system operation that ignores the boundary. */
  async function everywhere(probe: Probe, statement: string, id: string): Promise<Record<string, unknown> | undefined> {
    for (const workspaceId of [probe.fixture.a.id, probe.fixture.b.id]) {
      const rows = await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return tx.unsafe<Record<string, unknown>[]>(statement, [id]);
      });
      if (rows[0] !== undefined) {
        return rows[0];
      }
    }
    return undefined;
  }

  /** The handler as it should be: the row is read inside the tenant transaction of the caller's workspace. */
  async function loadInTenant(probe: Probe, call: ApiCall): Promise<ApiResponse> {
    const id = call.targets["bookmarkId"];
    const [select] = probe.methods;
    if (select === undefined) {
      throw new Error("the probe has no methods");
    }
    const rows = await database().tenant.withTenant(
      { accountId: call.principal.accountId, workspaceId: probe.fixture.a.id, requestId: "api-mode" },
      (tx) => select.invoke(tx),
    );
    const row = rows.find((candidate) => (candidate as { id?: string }).id === id);
    return row === undefined ? { status: 404, body: { title: "Not Found", instance: call.url } } : { status: 200, body: row };
  }

  it("passes a handler that reads inside the tenant transaction", async () => {
    const report = await runApiMatrix({
      document: READ_API,
      fixture: sessionsOnly(scoped.fixture),
      mapping,
      request: (call) => loadInTenant(scoped, call),
    });
    expect(report.failures).toEqual([]);
    // three principals of A against the shared and the unshared bookmark of B
    expect(report.attempts).toBe(6);
  });

  it("detects the endpoint that loads a row by id outside the tenant transaction", async () => {
    const report = await runApiMatrix({
      document: READ_API,
      fixture: sessionsOnly(scoped.fixture),
      mapping,
      request: async (call) => {
        const row = await everywhere(scoped, `SELECT * FROM ${scoped.table} WHERE id = $1`, call.targets["bookmarkId"] ?? "");
        return row === undefined ? { status: 404 } : { status: 200, body: row };
      },
    });
    expect(new Set(report.failures.map((failure) => failure.kind))).toEqual(new Set(["unexpected_status", "leaked_name"]));
    expect(report.failures.every((failure) => failure.subject.includes("getBookmark"))).toBe(true);
    expect(report.failures.filter((failure) => failure.kind === "unexpected_status")).toHaveLength(6);
  });

  it("detects the same endpoint changing a row of B, by the checksum, even when it answers 404", async () => {
    const report = await runApiMatrix({
      document: DELETE_API,
      fixture: sessionsOnly(victim.fixture),
      mapping,
      request: async (call) => {
        await everywhere(victim, `DELETE FROM ${victim.table} WHERE id = $1 RETURNING *`, call.targets["bookmarkId"] ?? "");
        return { status: 404 };
      },
    });
    // the first attempt against each of the two rows removes it
    expect(report.failures.map((failure) => failure.kind)).toEqual(["workspace_changed", "workspace_changed"]);
    expect(report.failures[0]?.subject).toContain("deleteBookmark");
  });
});

describe("RLS-only mode as an instance admin outside both workspaces", () => {
  const withAdmin = (fixture: TenantFixture): TenantFixture => ({ ...fixture, instanceAdmin: PROBE_INSTANCE_ADMIN });

  // The flag opens nothing in a tenant table: a transaction of the admin's account with no workspace set reads no row of A or of B and writes none.
  it("passes for a table with a workspace policy: nothing is read, and every write naming A or B is refused or touches no row", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: withAdmin(scoped.fixture),
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    // select and delete without a predicate, and the insert and the update each naming A and naming B
    expect(report.instanceAdminAttempts).toBe(6);
    // the two inserts: row-level security refuses a row of any workspace when none is set; the two updates find no row to touch
    expect(report.instanceAdminRefusals).toBe(2);
    expect(report.attempts).toBe(6);
  });

  it("runs only when the fixture holds an instance admin", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.instanceAdminAttempts).toBe(0);
    expect(report.instanceAdminRefusals).toBe(0);
  });

  it("fails for a table whose policy is USING (true): the account with no workspace reads and writes the rows of A and B", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: withAdmin(permissive.fixture),
      methods: permissive.methods,
      samples: { [permissive.repository]: permissive.sample },
    });
    const asInstanceAdmin = report.failures.filter((failure) => failure.kind.startsWith("instance_admin_"));
    expect(new Set(asInstanceAdmin.map((failure) => [failure.subject.split(" ")[0], failure.kind].join(" ")))).toEqual(
      new Set([
        "matrix_probe_open.select instance_admin_read_row",
        "matrix_probe_open.insert instance_admin_wrote_row",
        "matrix_probe_open.update instance_admin_wrote_row",
        "matrix_probe_open.delete instance_admin_wrote_row",
      ]),
    );
    expect(asInstanceAdmin.every((failure) => /as the instance admin/.test(failure.detail) && /to an account with no workspace/.test(failure.detail))).toBe(true);
    expect(report.instanceAdminRefusals).toBe(0);
  });

  it("leaves the rows of A and B as it found them", async () => {
    const before = await Promise.all([victim.fixture.checksum(PROBE_WORKSPACE_A), victim.fixture.checksum(PROBE_WORKSPACE_B)]);
    await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: withAdmin(victim.fixture),
      methods: victim.methods,
      samples: { [victim.repository]: victim.sample },
    });
    expect(await Promise.all([victim.fixture.checksum(PROBE_WORKSPACE_A), victim.fixture.checksum(PROBE_WORKSPACE_B)])).toEqual(before);
  });
});

// The archive operation of doc 01 section 13.3 writes `bookmarks.plan_archived_at` and the counters of `workspaces`, which the application
// role cannot write through a repository, so it is not an entry of the registry the matrix above runs: it is the system operation
// `sys_bookmark_archive_set`, whose own guard is the workspace of the transaction and its membership. This runs it the way the RLS-only
// mode runs a method, inside withTenant(A) and with the application layer left out (the function called by hand, naming B), against
// the rows of B.
describe("the archive operation across workspaces", () => {
  const MEMBER_OF_A = "0192f3a0-3333-7000-8000-00000000a0a1";
  const BOOKMARK_OF_A = "0192f3a0-2222-7000-8000-00000000a0b1";
  const BOOKMARK_OF_B = "0192f3a0-2222-7000-8000-00000000b0b1";

  interface Stored {
    readonly archived: number;
    readonly counter: number;
    readonly version: number;
  }

  async function storedOf(workspaceId: string): Promise<Stored> {
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<Stored[]>`
        SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND plan_archived_at IS NOT NULL)::int AS archived,
               bookmark_count AS counter, entitlement_version AS version
        FROM workspaces WHERE id = ${workspaceId}`;
    });
    return rows[0] ?? { archived: -1, counter: -1, version: -1 };
  }

  it("changes no bookmark, counter or version of B from a transaction acting in A, through the repository or by naming B to the function", async () => {
    await seedWorkspaceRows(database(), [
      { id: PROBE_WORKSPACE_A, bookmarkId: BOOKMARK_OF_A },
      { id: PROBE_WORKSPACE_B, bookmarkId: BOOKMARK_OF_B },
    ]);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${MEMBER_OF_A}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${MEMBER_OF_A}, 'archive-matrix@example.test', 'Matrix member') ON CONFLICT DO NOTHING`;
    });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${PROBE_WORKSPACE_A}, ${MEMBER_OF_A}, 'owner') ON CONFLICT DO NOTHING`;
    });
    const before = { a: await storedOf(PROBE_WORKSPACE_A), b: await storedOf(PROBE_WORKSPACE_B) };
    const context = { accountId: MEMBER_OF_A, workspaceId: PROBE_WORKSPACE_A, requestId: "matrix-archive" };

    const byRepository = await database().tenant.withTenant(context, (tx) => bookmarkRepository(tx).setArchived({ bookmarkIds: [BOOKMARK_OF_B], archived: true }));
    const namingB = await database().app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${MEMBER_OF_A}, true), set_config('app.workspace_id', ${PROBE_WORKSPACE_A}, true)`;
      const rows = await tx<{ changed: number | null }[]>`
        SELECT public.sys_bookmark_archive_set(${PROBE_WORKSPACE_B}::uuid, ${`{${BOOKMARK_OF_B}}`}::uuid[], true) AS changed`;
      return rows[0]?.changed;
    });

    expect(byRepository).toBe(0);
    expect(namingB).toBeNull();
    expect({ a: await storedOf(PROBE_WORKSPACE_A), b: await storedOf(PROBE_WORKSPACE_B) }).toEqual({ a: before.a, b: before.b });
  });
});

// The bulk delete and the bulk pin of doc 02 section 5.8 act on the rows of the workspace of the transaction. The delete is the system operation
// `sys_bookmark_delete_many`, whose guard is the workspace of the transaction and the owner; the pin is a repository method that runs
// on the policies of `bookmarks`. This runs both inside withTenant(A) naming the bookmark of B, through the repository and, for the delete, by
// calling the function by hand with the application layer left out.
describe("the bulk operations across workspaces", () => {
  const MEMBER_OF_A = "0192f3a0-3333-7000-8000-00000000a0a2";
  const BOOKMARK_OF_A = "0192f3a0-2222-7000-8000-00000000a0b2";
  const BOOKMARK_OF_B = "0192f3a0-2222-7000-8000-00000000b0b2";

  interface Stored {
    readonly rows: number;
    readonly pinned: number;
    readonly versions: number;
    readonly counter: number;
  }

  async function storedOf(workspaceId: string): Promise<Stored> {
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<Stored[]>`
        SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows,
               (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND pinned_at IS NOT NULL)::int AS pinned,
               (SELECT coalesce(sum(version), 0) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS versions,
               bookmark_count AS counter
        FROM workspaces WHERE id = ${workspaceId}`;
    });
    return rows[0] ?? { rows: -1, pinned: -1, versions: -1, counter: -1 };
  }

  it("deletes, pins and unpins no bookmark of B, and changes no counter of B, from a transaction acting in A, through the repository or by naming B to the function", async () => {
    await seedWorkspaceRows(database(), [
      { id: PROBE_WORKSPACE_A, bookmarkId: BOOKMARK_OF_A },
      { id: PROBE_WORKSPACE_B, bookmarkId: BOOKMARK_OF_B },
    ]);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${MEMBER_OF_A}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${MEMBER_OF_A}, 'bulk-matrix@example.test', 'Matrix member') ON CONFLICT DO NOTHING`;
    });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      // The same account owns a bookmark in each workspace, so that the guard under test is the workspace of the transaction and not the ownership.
      await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${PROBE_WORKSPACE_A}, ${MEMBER_OF_A}, 'owner'), (${PROBE_WORKSPACE_B}, ${MEMBER_OF_A}, 'owner') ON CONFLICT DO NOTHING`;
      await tx`UPDATE bookmarks SET owner_id = ${MEMBER_OF_A} WHERE id IN (${BOOKMARK_OF_A}, ${BOOKMARK_OF_B})`;
      await tx`UPDATE workspaces SET bookmark_count = (SELECT count(*) FROM bookmarks WHERE workspace_id = workspaces.id AND plan_archived_at IS NULL) WHERE id IN (${PROBE_WORKSPACE_A}, ${PROBE_WORKSPACE_B})`;
    });
    const before = { a: await storedOf(PROBE_WORKSPACE_A), b: await storedOf(PROBE_WORKSPACE_B) };
    expect(before.b.rows).toBeGreaterThanOrEqual(1);
    expect(before.b.counter).toBe(before.b.rows);
    const context = { accountId: MEMBER_OF_A, workspaceId: PROBE_WORKSPACE_A, requestId: "matrix-bulk" };

    const results = await database().tenant.withTenant(context, async (tx) => {
      const repository = bookmarkRepository(tx);
      return {
        deleted: await repository.removeMany({ bookmarkIds: [BOOKMARK_OF_B] }),
        pinned: await repository.setPinned({ bookmarkIds: [BOOKMARK_OF_B], ownerId: MEMBER_OF_A, pinned: true }),
        unpinned: await repository.setPinned({ bookmarkIds: [BOOKMARK_OF_B], ownerId: MEMBER_OF_A, pinned: false }),
        ids: await repository.ids({ ownerId: MEMBER_OF_A }, 100),
      };
    });
    const namingB = await database().app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${MEMBER_OF_A}, true), set_config('app.workspace_id', ${PROBE_WORKSPACE_A}, true)`;
      const rows = await tx<{ deleted: number | null }[]>`
        SELECT public.sys_bookmark_delete_many(${PROBE_WORKSPACE_B}::uuid, ${`{${BOOKMARK_OF_B}}`}::uuid[]) AS deleted`;
      return rows[0]?.deleted;
    });

    expect(results).toEqual({ deleted: 0, pinned: 0, unpinned: 0, ids: [BOOKMARK_OF_A] });
    expect(namingB).toBeNull();
    expect({ a: await storedOf(PROBE_WORKSPACE_A), b: await storedOf(PROBE_WORKSPACE_B) }).toEqual({ a: before.a, b: before.b });
  });
});
