import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/audit-events (doc 04 sections 6.1 and 10.5, doc 02 section 10, doc 05 section 2.9, doc 10 T1 and T11), through the whole chain over the
// migrated database. The failure scenario: an admin of workspace A who lists with a cursor taken from the log of workspace B, with an entity or an
// account of B, and with an action that the events of the deployment (which have no workspace) share, gets 400 for the cursor and otherwise a page of
// A's events only, with no event of B and none of the instance stream in it. Besides that: a plain member, an API token and a workspace without
// `audit.log` are refused; a page is newest first with the identifier as the tiebreak and a cursor opens only with the filters it was issued for;
// each filter narrows as the contract says; an event shows its actor's label at the time and never a network.

const TEST_TIMEOUT_MS = 60_000;
const AUDIT = "/api/v1/audit-events";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "audit.log";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly entitlement?: string;
}

interface Event {
  readonly id: string;
  readonly createdAt: string;
  readonly actor: { readonly type: string; readonly accountId: string | null; readonly label: string };
  readonly action: string;
  readonly category: string | null;
  readonly entity: { readonly type: string; readonly id: string } | null;
  readonly metadata: Record<string, string>;
}

interface EventList {
  readonly items: readonly Event[];
  readonly nextCursor: string | null;
}

const list = (world: World, as: Person, query = "") => send(world, "GET", `${AUDIT}${query}`, { cookie: as.cookie });

async function page(response: Response): Promise<EventList> {
  expect(response.status).toBe(200);
  return (await response.json()) as EventList;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

interface Seeded {
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly actorAccountId?: string | null;
  readonly actorLabel?: string;
  readonly action?: string;
  readonly entity?: { readonly type: string; readonly id: string };
  readonly id?: string;
}

/** Writes an event as the system, the one role that names a time and a workspace of its own, so a test fixes the order and the stream an event is in. */
async function seed(event: Seeded): Promise<string> {
  const id = event.id ?? crypto.randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix, created_at)
      VALUES (${id}, ${event.workspaceId}, ${event.actorAccountId === undefined || event.actorAccountId === null ? "system" : "account"}, ${event.actorAccountId ?? null},
              ${event.actorLabel ?? "Ada"}, ${event.action ?? "workspace.renamed"}, ${event.entity?.type ?? null}, ${event.entity?.id ?? null},
              '{"from":"Old","to":"New"}'::jsonb, '203.0.113.0/24', ${event.createdAt}::text::timestamptz)`;
  });
  return id;
}

async function auditRowsOf(workspaceId: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`SELECT md5(coalesce(string_agg(e::text, '|' ORDER BY e.id), '')) AS digest FROM audit_events e WHERE e.workspace_id = ${workspaceId}`;
  });
  return rows[0]?.digest ?? "";
}

/** Workspace A with an owner, an admin and two plain members, and workspace B of a stranger who owns it. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const admin = await harness.person(world);
  const member = await harness.person(world);
  const other = await harness.person(world);
  const stranger = await harness.person(world);
  const a = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: admin, role: "admin" },
    { person: member, role: "member" },
    { person: other, role: "member" },
  ]);
  const b = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, admin, member, other, stranger, a, b };
}

describe("the failure scenario", () => {
  it(
    "shows an admin of workspace A no event of B and none of the instance stream, whatever cursor, entity, account or action it names",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, owner, stranger, a, b } = await setup(world);
      const entityOfB = crypto.randomUUID();
      const entityOfInstance = crypto.randomUUID();
      const accountOfInstance = (await harness.person(world)).account.id;
      const own = [
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-02-01T10:00:00Z", actorAccountId: owner.account.id, actorLabel: "Owner of A", entity: { type: "workspace", id: a.workspaceId } }),
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-02-02T10:00:00Z", actorAccountId: admin.account.id, actorLabel: "Admin of A", entity: { type: "workspace", id: a.workspaceId } }),
      ];
      const ofB = [
        await seed({ workspaceId: b.workspaceId, createdAt: "2026-02-03T10:00:00Z", actorAccountId: stranger.account.id, actorLabel: "Stranger of B", entity: { type: "bookmark", id: entityOfB } }),
        await seed({ workspaceId: b.workspaceId, createdAt: "2026-02-04T10:00:00Z", actorAccountId: stranger.account.id, actorLabel: "Stranger of B", entity: { type: "bookmark", id: entityOfB } }),
        await seed({ workspaceId: b.workspaceId, createdAt: "2026-02-05T10:00:00Z", actorAccountId: stranger.account.id, actorLabel: "Stranger of B", entity: { type: "bookmark", id: entityOfB } }),
      ];
      const ofInstance = [
        await seed({ workspaceId: null, createdAt: "2026-02-06T10:00:00Z", actorAccountId: accountOfInstance, actorLabel: "Instance admin", entity: { type: "workspace", id: entityOfInstance } }),
        await seed({ workspaceId: null, createdAt: "2026-02-07T10:00:00Z", actorLabel: "SlugBase", entity: { type: "workspace", id: entityOfInstance } }),
      ];
      const foreign = [...ofB, ...ofInstance];
      const checksumOfB = await auditRowsOf(b.workspaceId);

      // The cursor B's owner gets for its own log, and a cursor made up.
      const ofBPage = await page(await list(world, stranger, "?limit=1"));
      const cursorOfB = ofBPage.nextCursor ?? "";
      expect(cursorOfB).not.toBe("");
      const forged = `${Buffer.from(JSON.stringify({ key: ["2099-01-01T00:00:00.000000Z", ofB[0]] })).toString("base64url")}.${"A".repeat(43)}`;
      const responses = [
        await list(world, admin, `?cursor=${cursorOfB}`),
        await list(world, owner, `?cursor=${cursorOfB}`),
        await list(world, admin, `?cursor=${forged}`),
        await list(world, admin, "?cursor=not-a-cursor"),
      ];
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
      for (const response of responses) {
        expect((await problemOf(response)).code).toBe("bad_request");
      }

      const queries = [
        "",
        `?entityId=${entityOfB}`,
        "?entityType=bookmark",
        `?actorAccountId=${stranger.account.id}`,
        `?entityId=${entityOfInstance}`,
        `?actorAccountId=${accountOfInstance}`,
        "?action=workspace.renamed",
        "?action=workspace.renamed&action=member.removed&category=workspace",
        "?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z",
        "?limit=100",
      ];
      for (const as of [admin, owner]) {
        for (const query of queries) {
          const response = await list(world, as, query);
          const body = await page(response);
          const text = JSON.stringify(body);
          expect(body.items.map((item) => item.id).filter((id) => foreign.includes(id))).toEqual([]);
          for (const hidden of [...foreign, "Stranger of B", "Instance admin", "SlugBase", entityOfB, entityOfInstance]) {
            expect(text).not.toContain(hidden);
          }
          expect(body.items.every((item) => own.includes(item.id))).toBe(true);
        }
      }
      expect((await page(await list(world, admin))).items.map((item) => item.id)).toEqual([own[1], own[0]]);
      expect(await auditRowsOf(b.workspaceId)).toBe(checksumOfB);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("who may read the log", () => {
  it(
    "is an admin or an owner: a plain member is refused 403 forbidden, a token 403, and no session 401",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, member, other, a } = await setup(world);
      await seed({ workspaceId: a.workspaceId, createdAt: "2026-02-01T10:00:00Z", actorAccountId: owner.account.id });
      const readToken = await harness.token(a.workspaceId, admin, "read");
      const writeToken = await harness.token(a.workspaceId, admin, "read-write");

      for (const as of [member, other]) {
        const response = await list(world, as);
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe("forbidden");
      }
      for (const token of [readToken, writeToken]) {
        expect((await send(world, "GET", AUDIT, bearer(token))).status).toBe(403);
      }
      expect((await send(world, "GET", AUDIT, {})).status).toBe(401);
      for (const as of [admin, owner]) {
        expect((await page(await list(world, as))).items).toHaveLength(1);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs the audit.log entitlement, checked on the server: a workspace without it is refused 403 entitlement_required, an owner included, and one that holds it reads",
    async () => {
      const closed = harness.serve();
      const refusing = harness.serve({ entitlements: () => false });
      const granted = harness.serve({ entitlements: GRANTED });
      const { owner, admin, member, a } = await setup(granted);
      await seed({ workspaceId: a.workspaceId, createdAt: "2026-02-01T10:00:00Z", actorAccountId: owner.account.id });

      for (const world of [closed, refusing]) {
        for (const as of [owner, admin]) {
          const response = await list(world, as);
          expect(response.status).toBe(403);
          expect(await problemOf(response)).toMatchObject({ code: "entitlement_required", entitlement: "audit.log" });
        }
        // A plain member is refused for its role before the entitlement is looked at.
        expect((await problemOf(await list(world, member))).code).toBe("forbidden");
      }
      expect((await page(await list(granted, owner))).items).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a page of the log", () => {
  it(
    "is newest first with the identifier as the tiebreak, and the cursor resumes after the last event with no gap and no repeat",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, a } = await setup(world);
      const ids = [
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:00:00.000001Z", id: "0192f3a0-1111-7000-8000-000000000001" }),
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:00:00Z", id: "0192f3a0-1111-7000-8000-000000000009" }),
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:00:00Z", id: "0192f3a0-1111-7000-8000-000000000005" }),
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:00:00Z", id: "0192f3a0-1111-7000-8000-000000000002" }),
        await seed({ workspaceId: a.workspaceId, createdAt: "2026-02-28T23:59:59.999999Z", id: "0192f3a0-1111-7000-8000-000000000003" }),
      ];

      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const body: EventList = await page(await list(world, owner, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`));
        walked.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(walked).toEqual(ids);
      expect(pages).toBe(3);
      expect((await page(await list(world, owner, "?limit=5"))).nextCursor).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "opens only with the filters it was issued for: another action, category, actor, entity, time or workspace is 400 bad_request",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, a, b, stranger } = await setup(world);
      for (let index = 1; index <= 4; index += 1) {
        await seed({ workspaceId: a.workspaceId, createdAt: `2026-03-0${String(index)}T10:00:00Z`, actorAccountId: owner.account.id, action: "workspace.renamed" });
      }
      await seed({ workspaceId: b.workspaceId, createdAt: "2026-03-01T10:00:00Z", actorAccountId: stranger.account.id, action: "workspace.renamed" });
      await seed({ workspaceId: b.workspaceId, createdAt: "2026-03-02T10:00:00Z", actorAccountId: stranger.account.id, action: "workspace.renamed" });
      const first = await page(await list(world, owner, "?action=workspace.renamed&limit=2"));
      const cursor = first.nextCursor ?? "";
      expect(cursor).not.toBe("");

      const refused = [
        "?limit=2",
        "?action=member.removed&limit=2",
        "?action=workspace.renamed&action=member.removed&limit=2",
        "?action=workspace.renamed&category=team&limit=2",
        `?action=workspace.renamed&actorAccountId=${owner.account.id}&limit=2`,
        `?action=workspace.renamed&entityId=${crypto.randomUUID()}&limit=2`,
        "?action=workspace.renamed&entityType=workspace&limit=2",
        "?action=workspace.renamed&from=2026-01-01T00:00:00Z&limit=2",
        "?action=workspace.renamed&to=2026-12-01T00:00:00Z&limit=2",
      ];
      for (const query of refused) {
        const response = await list(world, owner, `${query}&cursor=${cursor}`);
        expect([query, response.status]).toEqual([query, 400]);
      }
      // The page size is no part of what a cursor is bound to, and another workspace's owner cannot open it.
      expect((await page(await list(world, owner, `?action=workspace.renamed&limit=1&cursor=${cursor}`))).items).toHaveLength(1);
      expect((await list(world, stranger, `?action=workspace.renamed&limit=2&cursor=${cursor}`)).status).toBe(400);
      // The same cursor, with the same filters, in another order of the repeated action and by another admin of the workspace, opens.
      expect((await page(await list(world, admin, `?action=workspace.renamed&limit=2&cursor=${cursor}`))).items).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "carries the time, the actor with the label it had, the action with its category, the entity and the metadata, and no network",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, a } = await setup(world);
      const entity = crypto.randomUUID();
      const id = await seed({
        workspaceId: a.workspaceId,
        createdAt: "2026-03-01T10:20:30.123456Z",
        actorAccountId: owner.account.id,
        actorLabel: "Owner as it was called then",
        action: "workspace.renamed",
        entity: { type: "workspace", id: entity },
      });
      const systemId = await seed({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:20:31Z", actorLabel: "SlugBase", action: "retired.action" });

      const response = await list(world, admin);
      const body = await page(response);

      expect(body.items).toEqual([
        { id: systemId, createdAt: "2026-03-01T10:20:31.000000Z", actor: { type: "system", accountId: null, label: "SlugBase" }, action: "retired.action", category: null, entity: null, metadata: { from: "Old", to: "New" } },
        {
          id,
          createdAt: "2026-03-01T10:20:30.123456Z",
          actor: { type: "account", accountId: owner.account.id, label: "Owner as it was called then" },
          action: "workspace.renamed",
          category: "workspace",
          entity: { type: "workspace", id: entity },
          metadata: { from: "Old", to: "New" },
        },
      ]);
      expect(JSON.stringify(body)).not.toMatch(/203\.0\.113|ip_?prefix|network/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the label of an actor whose account is deleted and answers its reference as null",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, a } = await setup(world);
      const leaver = await harness.person(world);
      await seed({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:00:00Z", actorAccountId: leaver.account.id, actorLabel: "Leaver then" });
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`DELETE FROM accounts WHERE id = ${leaver.account.id}`;
      });

      const [event] = (await page(await list(world, owner))).items;

      expect(event?.actor).toEqual({ type: "account", accountId: null, label: "Leaver then" });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the filters", () => {
  it(
    "narrow by actor, exact action (repeatable), category, entity type and entity, and a time range that includes from and excludes to",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, a } = await setup(world);
      const teamEntity = crypto.randomUUID();
      const memberEntity = crypto.randomUUID();
      const renamed = await seed({ workspaceId: a.workspaceId, createdAt: "2026-01-10T00:00:00Z", actorAccountId: owner.account.id, action: "workspace.renamed", entity: { type: "workspace", id: a.workspaceId } });
      const removed = await seed({ workspaceId: a.workspaceId, createdAt: "2026-01-20T00:00:00Z", actorAccountId: admin.account.id, action: "member.removed", entity: { type: "member", id: memberEntity } });
      const joined = await seed({ workspaceId: a.workspaceId, createdAt: "2026-01-30T00:00:00Z", actorAccountId: owner.account.id, action: "member.joined", entity: { type: "member", id: memberEntity } });
      const team = await seed({ workspaceId: a.workspaceId, createdAt: "2026-01-31T00:00:00Z", actorAccountId: admin.account.id, action: "team.created", entity: { type: "team", id: teamEntity } });
      const idsFor = async (query: string): Promise<string[]> => (await page(await list(world, owner, query))).items.map((item) => item.id);

      expect(await idsFor("")).toEqual([team, joined, removed, renamed]);
      expect(await idsFor(`?actorAccountId=${admin.account.id}`)).toEqual([team, removed]);
      expect(await idsFor("?action=member.joined")).toEqual([joined]);
      expect(await idsFor("?action=member.joined&action=team.created")).toEqual([team, joined]);
      expect(await idsFor("?action=member.unknown")).toEqual([]);
      expect(await idsFor("?category=member")).toEqual([joined, removed]);
      expect(await idsFor("?category=member&action=member.removed&action=team.created")).toEqual([removed]);
      expect(await idsFor("?category=team&action=member.removed")).toEqual([]);
      expect(await idsFor("?entityType=member")).toEqual([joined, removed]);
      expect(await idsFor(`?entityId=${memberEntity}`)).toEqual([joined, removed]);
      expect(await idsFor(`?entityType=team&entityId=${memberEntity}`)).toEqual([]);
      expect(await idsFor("?from=2026-01-20T00:00:00Z")).toEqual([team, joined, removed]);
      expect(await idsFor("?to=2026-01-30T00:00:00Z")).toEqual([removed, renamed]);
      expect(await idsFor("?from=2026-01-20T00:00:00Z&to=2026-01-31T00:00:00Z")).toEqual([joined, removed]);
      expect(await idsFor(`?actorAccountId=${owner.account.id}&category=member&from=2026-01-25T00:00:00Z`)).toEqual([joined]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuse what is not a filter with 422 validation_failed: a malformed identifier, action, category or time, a limit out of range and a parameter the operation does not have",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner } = await setup(world);
      const queries = [
        "?actorAccountId=not-a-uuid",
        "?entityId=1",
        "?action=Not%20An%20Action",
        "?action=nodot",
        `?action=${"a".repeat(65)}.b`,
        "?category=everything",
        "?entityType=Bad%20Type",
        "?from=yesterday",
        "?to=2026-13-45T00:00:00Z",
        "?limit=0",
        "?limit=101",
        "?limit=many",
        "?sort=oldest",
        "?ip=203.0.113.0",
        `?${Array.from({ length: 21 }, () => "action=member.joined").join("&")}`,
      ];
      for (const query of queries) {
        const response = await list(world, owner, query);
        expect([query.slice(0, 40), response.status]).toEqual([query.slice(0, 40), 422]);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
