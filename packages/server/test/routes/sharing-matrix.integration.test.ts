import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import { ACTIONS, expected, expectedForFolder, FOLDER_ACTIONS, FOLDER_RELATIONS, RELATIONS, type Action, type FolderAction, type FolderRelation, type Relation } from "./access-oracle.ts";

// The within-workspace access matrix of doc 02 section 8.2 through the HTTP operations (doc 08 section 3.3, doc 04 section 2.4, doc 10 T2, T11 and T12), over the
// migrated database. The oracle (`access-oracle.ts`) states the table itself and imports nothing from the code judged here; for every action and every way to
// perform it, each relation of a member to the bookmark (the owner, a direct share, a team share, a shared folder, no share, an admin with no share, and a member who
// has left) makes the request, and the answer must be the oracle's: done, `403 forbidden` for a member who can read the bookmark, `404 not_found` for one who cannot,
// or, for a list, a `200` that leaves the bookmark out. A request that is refused leaves every row of the tables it could write as it was. The owner asks last,
// since an owner's request changes the bookmark. The same table judges the share operations of a folder, for the relations a folder can have (a direct share, a
// team share, none, an admin with no share and a member who has left): a recipient is told `403`, a member who cannot read the folder `404`, and the answer
// to each is the one `GET /folders/{id}` agrees with. Besides the table: the owner's tags, pin and folders reach no recipient, and the recipient cannot reach the tag.

const TEST_TIMEOUT_MS = 90_000;
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const TEAMS = "/api/v1/teams";
const MEMBERS = "/api/v1/members";
const SEARCH = "/api/v1/search";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = {
  RATE_LIMIT_BULK_IP: "10000/hour",
  RATE_LIMIT_BULK_ACCOUNT: "10000/hour",
  RATE_LIMIT_WRITE_IP: "10000/min",
  RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
  RATE_LIMIT_READ_IP: "10000/min",
  RATE_LIMIT_READ_ACCOUNT: "10000/min",
};
const SHELL = '<!doctype html><html><head><title>SlugBase shell</title></head><body><div id="root"></div></body></html>';
const OWNERS_URL = "https://example.com/the-owners-bookmark";
const PRIVATE_TAG = "private-tag";

const database = useTestDatabase();
const harness = workspaceHarness(database);
let webRoot: string;
let world: World;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "slugbase-sharing-matrix-"));
  writeFileSync(join(webRoot, "index.html"), SHELL);
  await harness.start();
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  world = harness.serve({ entitlements: GRANTED, env: RELAXED, webRoot });
  cast = await setup(world);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

const as = (person: Person): Record<string, string> => ({ cookie: person.cookie });

interface Problem {
  readonly code: string;
}

interface Hit {
  readonly id: string;
  readonly pinned: boolean;
  readonly tags?: readonly { readonly id: string; readonly name: string }[];
  readonly folders?: readonly { readonly id: string }[];
}

async function idOf(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(201);
  return ((await settled.json()) as { id: string }).id;
}

/** The answer of a request as the oracle names it: the statuses that mean it was done, `forbidden`, `not_found`, or what was actually answered. */
async function outcomeOf(response: Response, done: readonly number[]): Promise<string> {
  if (done.includes(response.status)) {
    return "allowed";
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/problem+json")) {
    return `${String(response.status)} without a problem document`;
  }
  const { code } = (await response.json()) as Problem;
  return response.status === 403 && code === "forbidden" ? "forbidden" : response.status === 404 && code === "not_found" ? "not_found" : `${String(response.status)} ${code}`;
}

/** What is in the tables a refused request could write; the counts of opens are the usage buffer's and leave the comparison. */
async function snapshot(): Promise<string> {
  const parts: string[] = [];
  for (const [table, row, where] of [
    ["bookmarks", "(to_jsonb(t) - 'open_count' - 'last_opened_at')::text", undefined],
    ["bookmark_tags", "t::text", undefined],
    ["folder_bookmarks", "t::text", undefined],
    ["bookmark_shares", "t::text", undefined],
    ["folder_shares", "t::text", undefined],
    ["tags", "t::text", undefined],
    ["folders", "t::text", undefined],
    ["audit_events", "t::text", "t.action LIKE 'share.%'"],
  ] as const) {
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx.unsafe<{ row: string }[]>(`SELECT ${row} AS row FROM ${table} t ${where === undefined ? "" : `WHERE ${where}`} ORDER BY 1`);
    });
    parts.push(`${table}\n${rows.map((entry) => entry.row).join("\n")}`);
  }
  return parts.join("\n");
}

interface Cast {
  readonly people: Readonly<Record<Relation, Person>>;
  /** A member with no relation to any bookmark, whom the owner's requests share with. */
  readonly spare: Person;
  readonly spareTeam: string;
  readonly folderOf: Readonly<Record<Relation, string>>;
  readonly tag: string;
  /** For each action, the owner's bookmark the action is asked of, with its slug. */
  readonly bookmarks: Readonly<Record<Action, { readonly id: string; readonly slug: string }>>;
  /** A bookmark nobody else is asked about, for the checks of what recipients see. */
  readonly leak: { readonly id: string; readonly slug: string };
  readonly sharedFolder: string;
  /** For each action that applies to a folder, the owner's folder it is asked of: shared with `direct` and `former` directly and with `team` and `former` through a team. */
  readonly folderObjects: Readonly<Record<FolderAction, string>>;
}

let cast: Cast;

/**
 * Workspace A: the owner; a member for each way of reading the bookmark; a member with no share; an admin with no share; and a member who had a direct share and a team
 * share and has left. Every bookmark is the owner's, tagged with the owner's private tag, pinned, and filed in a folder that is shared with `folder`.
 */
async function setup(serving: World): Promise<Cast> {
  const [owner, direct, team, folder, none, admin, former, spare] = await Promise.all(Array.from({ length: 8 }, () => harness.person(serving)));
  if (owner === undefined || direct === undefined || team === undefined || folder === undefined || none === undefined || admin === undefined || former === undefined || spare === undefined) {
    throw new Error("people were not made");
  }
  const people = { owner, direct, team, folder, none, admin, former } as const;
  await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: direct, role: "member" },
    { person: team, role: "member" },
    { person: folder, role: "member" },
    { person: none, role: "member" },
    { person: admin, role: "admin" },
    { person: former, role: "member" },
    { person: spare, role: "member" },
  ]);
  const tag = await idOf(send(serving, "POST", TAGS, as(owner), { name: PRIVATE_TAG }));
  const sharedFolder = await idOf(send(serving, "POST", FOLDERS, as(owner), { name: "Shared folder" }));
  const readers = await idOf(send(serving, "POST", TEAMS, as(owner), { name: "Readers" }));
  expect((await send(serving, "PUT", `${TEAMS}/${readers}/members`, as(owner), { accountIds: [team.account.id, former.account.id] })).status).toBe(200);
  const spareTeam = await idOf(send(serving, "POST", TEAMS, as(owner), { name: "Spare team" }));
  expect((await send(serving, "POST", `${FOLDERS}/${sharedFolder}/shares`, as(owner), { accountId: folder.account.id })).status).toBe(201);

  const make = async (name: string): Promise<{ id: string; slug: string }> => {
    const slug = `s-${name}`;
    const id = await idOf(send(serving, "POST", BOOKMARKS, as(owner), { url: OWNERS_URL, title: `Matrix ${name}`, slug, pinned: true, tagIds: [tag], folderIds: [sharedFolder] }));
    for (const target of [{ accountId: direct.account.id }, { accountId: former.account.id }, { teamId: readers }]) {
      expect((await send(serving, "POST", `${BOOKMARKS}/${id}/shares`, as(owner), target)).status).toBe(201);
    }
    return { id, slug };
  };
  const bookmarks = Object.fromEntries(await Promise.all(ACTIONS.map(async (action) => [action, await make(action)] as const))) as Record<Action, { id: string; slug: string }>;
  const leak = await make("leak");

  const folderObjects = Object.fromEntries(
    await Promise.all(
      FOLDER_ACTIONS.map(async (action) => {
        const id = await idOf(send(serving, "POST", FOLDERS, as(owner), { name: `Folder object ${action}` }));
        for (const target of [{ accountId: direct.account.id }, { accountId: former.account.id }, { teamId: readers }]) {
          expect((await send(serving, "POST", `${FOLDERS}/${id}/shares`, as(owner), target)).status).toBe(201);
        }
        return [action, id] as const;
      }),
    ),
  ) as Record<FolderAction, string>;

  // Each member has a folder of their own, which is theirs to file into.
  const folderOf = Object.fromEntries(
    await Promise.all(RELATIONS.map(async (relation) => [relation, await idOf(send(serving, "POST", FOLDERS, as(people[relation]), { name: `Own ${relation}` }))] as const)),
  ) as Record<Relation, string>;

  // The former member reads the bookmarks before they leave, through the direct share and through the team; the shares go with the membership, and every request of
  // theirs after it is made in no workspace.
  expect((await send(serving, "GET", `${BOOKMARKS}/${leak.id}`, as(former))).status).toBe(200);
  expect((await send(serving, "DELETE", `${MEMBERS}/${former.account.id}`, as(owner), { content: "delete" })).status).toBe(200);
  return { people, spare, spareTeam, folderOf, tag, bookmarks, leak, sharedFolder, folderObjects };
}

interface Probe {
  readonly name: string;
  readonly run: (as: Relation, bookmark: { readonly id: string; readonly slug: string }, extra: { readonly shareId: string }) => Promise<string>;
}

const request = (as: Relation, method: string, path: string, body?: unknown): Promise<Response> => send(world, method, path, { cookie: cast.people[as].cookie }, body);

const change = (name: string, body: (as: Relation) => unknown): Probe => ({
  name,
  run: async (as, bookmark) => outcomeOf(await request(as, "PATCH", `${BOOKMARKS}/${bookmark.id}`, body(as)), [200]),
});

/** A list or a search is allowed when it names the bookmark, hidden when it answers 200 without it. */
async function listing(response: Response, bookmarkId: string, items: (body: unknown) => readonly Hit[]): Promise<string> {
  if (response.status !== 200) {
    return outcomeOf(response, []);
  }
  return items(await response.json()).some((hit) => hit.id === bookmarkId) ? "allowed" : "hidden";
}

/** `/go/<slug>` forwards to the destination or is a page that does not exist (doc 02 section 6.2). */
async function forwarding(as: Relation, slug: string): Promise<string> {
  const response = await world.server.fetch(new Request(new URL(`/go/${slug}`, world.origin), { method: "GET", headers: { accept: "text/html", cookie: cast.people[as].cookie } }));
  if (response.headers.get("location") === OWNERS_URL) {
    return "allowed";
  }
  return response.status === 404 ? "not_found" : `${String(response.status)} ${response.headers.get("location") ?? ""}`;
}

/** For each action, the operations that perform it, in the order they are asked (an owner's request must not change what the next one judges). */
const PROBES: Readonly<Record<Action, readonly Probe[]>> = {
  see: [
    { name: "GET /bookmarks", run: async (as, b) => listing(await request(as, "GET", `${BOOKMARKS}?scope=all&limit=100`), b.id, (body) => (body as { items: Hit[] }).items) },
    { name: "GET /search", run: async (as, b) => listing(await request(as, "GET", `${SEARCH}?q=${b.slug}`), b.id, (body) => (body as { bookmarks: Hit[] }).bookmarks) },
  ],
  open: [
    { name: "GET /bookmarks/{id}", run: async (as, b) => outcomeOf(await request(as, "GET", `${BOOKMARKS}/${b.id}`), [200]) },
    { name: "POST /bookmarks/{id}/open", run: async (as, b) => outcomeOf(await request(as, "POST", `${BOOKMARKS}/${b.id}/open`), [200]) },
    { name: "GET /go/<slug>", run: (as, b) => forwarding(as, b.slug) },
  ],
  edit: [
    change("PATCH the title", () => ({ title: "Taken over" })),
    change("PATCH the address", () => ({ url: "https://example.com/elsewhere" })),
    change("PATCH the slug and forwarding", () => ({ slug: "taken-over", forwarding: false })),
  ],
  pin: [change("PATCH pinned", () => ({ pinned: false }))],
  tag: [change("PATCH tagIds", () => ({ tagIds: [cast.tag] })), change("PATCH tagNames", () => ({ tagNames: ["mine-now"] }))],
  file: [
    // The owner keeps the bookmark in the shared folder, which is the route of one of the recipients.
    change("PATCH folderIds", (as) => ({ folderIds: [cast.sharedFolder, cast.folderOf[as]] })),
    { name: "POST /folders/{id}/bookmarks", run: async (as, b) => outcomeOf(await request(as, "POST", `${FOLDERS}/${cast.folderOf[as]}/bookmarks`, { bookmarkIds: [b.id] }), [200]) },
    { name: "DELETE /folders/{id}/bookmarks", run: async (as, b) => outcomeOf(await request(as, "DELETE", `${FOLDERS}/${cast.folderOf[as]}/bookmarks`, { bookmarkIds: [b.id] }), [200]) },
  ],
  delete: [{ name: "DELETE /bookmarks/{id}", run: async (as, b) => outcomeOf(await request(as, "DELETE", `${BOOKMARKS}/${b.id}`), [204]) }],
  share: [
    { name: "POST shares with a member", run: async (as, b) => outcomeOf(await request(as, "POST", `${BOOKMARKS}/${b.id}/shares`, { accountId: cast.spare.account.id }), [200, 201]) },
    { name: "POST shares with a team", run: async (as, b) => outcomeOf(await request(as, "POST", `${BOOKMARKS}/${b.id}/shares`, { teamId: cast.spareTeam }), [200, 201]) },
    { name: "DELETE a share", run: async (as, b, extra) => outcomeOf(await request(as, "DELETE", `${BOOKMARKS}/${b.id}/shares/${extra.shareId}`), [204]) },
  ],
  "see-recipients": [{ name: "GET shares", run: async (as, b) => outcomeOf(await request(as, "GET", `${BOOKMARKS}/${b.id}/shares`), [200]) }],
};

/** The relations in the order they ask: the owner last. */
const ASKING: readonly Relation[] = [...RELATIONS.filter((relation) => relation !== "owner"), "owner"];

describe("the access matrix of doc 02 section 8.2, through the HTTP operations", () => {
  it("has the oracle that the core suite has", () => {
    const core = readFileSync(resolve(import.meta.dirname, "../../../core/test/sharing/access-oracle.ts"), "utf8");
    expect(readFileSync(resolve(import.meta.dirname, "access-oracle.ts"), "utf8")).toBe(core);
  });

  it.each(ACTIONS)(
    "%s: every relation gets the oracle's answer from every operation, and a refused request changes nothing",
    async (action) => {
      const bookmark = cast.bookmarks[action];
      // A share the owner's last request of the action revokes; the others try to.
      const shareId =
        action === "share"
          ? await (async () => {
              const response = await send(world, "POST", `${BOOKMARKS}/${bookmark.id}/shares`, as(cast.people.owner), { accountId: cast.spare.account.id });
              expect(response.status).toBe(201);
              return ((await response.json()) as { id: string }).id;
            })()
          : "";
      const answered: { probe: string; relation: Relation; outcome: string }[] = [];

      for (const probe of PROBES[action]) {
        const before = await snapshot();
        for (const relation of ASKING) {
          if (relation === "owner" && (action === "see" || action === "open")) {
            // A read changes nothing, so nothing is compared before the owner asks.
          } else if (relation === "owner") {
            expect(await snapshot(), `${probe.name}: a refused request changed a row`).toBe(before);
          }
          answered.push({ probe: probe.name, relation, outcome: await probe.run(relation, bookmark, { shareId }) });
        }
      }

      expect(answered).toEqual(answered.map(({ probe, relation }) => ({ probe, relation, outcome: expected(relation, action) })));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends with the owner's requests in force: the changes are the bookmark's and the deleted bookmark is gone",
    async () => {
      const { owner } = cast.people;
      const edited = await send(world, "GET", `${BOOKMARKS}/${cast.bookmarks.edit.id}`, as(owner));
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ title: "Taken over", slug: "taken-over", forwarding: false, ownerId: owner.account.id });
      expect((await send(world, "GET", `${BOOKMARKS}/${cast.bookmarks.delete.id}`, as(owner))).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});

interface FolderProbe {
  readonly name: string;
  readonly run: (as: Relation, folderId: string, extra: { readonly shareId: string }) => Promise<string>;
}

/** For each action that applies to a folder, the operations that perform it, in the order they are asked. */
const FOLDER_PROBES: Readonly<Record<FolderAction, readonly FolderProbe[]>> = {
  share: [
    { name: "POST shares with a member", run: async (as, id) => outcomeOf(await request(as, "POST", `${FOLDERS}/${id}/shares`, { accountId: cast.spare.account.id }), [200, 201]) },
    { name: "POST shares with a team", run: async (as, id) => outcomeOf(await request(as, "POST", `${FOLDERS}/${id}/shares`, { teamId: cast.spareTeam }), [200, 201]) },
    { name: "DELETE a share", run: async (as, id, extra) => outcomeOf(await request(as, "DELETE", `${FOLDERS}/${id}/shares/${extra.shareId}`), [204]) },
  ],
  "see-recipients": [{ name: "GET shares", run: async (as, id) => outcomeOf(await request(as, "GET", `${FOLDERS}/${id}/shares`), [200]) }],
};

describe("the access matrix of doc 02 section 8.2 for a folder, through the HTTP operations", () => {
  it.each(FOLDER_ACTIONS)(
    "%s: every relation gets the oracle's answer from every operation, and a refused request changes nothing",
    async (action) => {
      const folderId = cast.folderObjects[action];
      const shareId =
        action === "share"
          ? await (async () => {
              const response = await send(world, "POST", `${FOLDERS}/${folderId}/shares`, as(cast.people.owner), { accountId: cast.spare.account.id });
              expect(response.status).toBe(201);
              return ((await response.json()) as { id: string }).id;
            })()
          : "";
      const asking = ASKING.filter((relation): relation is FolderRelation => (FOLDER_RELATIONS as readonly Relation[]).includes(relation));
      const answered: { probe: string; relation: FolderRelation; outcome: string }[] = [];

      for (const probe of FOLDER_PROBES[action]) {
        const before = await snapshot();
        for (const relation of asking) {
          if (relation === "owner") {
            expect(await snapshot(), `${probe.name}: a refused request changed a row`).toBe(before);
          }
          answered.push({ probe: probe.name, relation, outcome: await probe.run(relation, folderId, { shareId }) });
        }
      }

      expect(answered).toEqual(answered.map(({ probe, relation }) => ({ probe, relation, outcome: expectedForFolder(relation, action) })));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "tells a member nothing through the share operations that GET /folders/{id} does not: a folder they can read is 403, one they cannot is 404, whichever share is named",
    async () => {
      const folderId = cast.folderObjects["see-recipients"];
      const unknownShare = "0192f3a0-cccc-7000-8000-0000000000ab";
      for (const relation of FOLDER_RELATIONS) {
        const read = await request(relation, "GET", `${FOLDERS}/${folderId}`);
        const answers = [
          await request(relation, "GET", `${FOLDERS}/${folderId}/shares`),
          await request(relation, "POST", `${FOLDERS}/${folderId}/shares`, { accountId: cast.people[relation].account.id }),
          await request(relation, "DELETE", `${FOLDERS}/${folderId}/shares/${unknownShare}`),
        ];
        if (relation === "owner") {
          expect(read.status).toBe(200);
          expect(answers.map((answer) => answer.status)).toEqual([200, 422, 404]);
          continue;
        }
        const readable = read.status === 200;
        expect(readable, relation).toBe(relation === "direct" || relation === "team");
        expect(await Promise.all(answers.map((answer) => outcomeOf(answer, [])))).toEqual(Array.from({ length: 3 }, () => (readable ? "forbidden" : "not_found")));
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers an ownerless folder as GET /folders/{id} shows it: 403 to a member it is still shared with, 404 to one it is not",
    async () => {
      const created = await send(world, "POST", FOLDERS, as(cast.people.owner), { name: "Ownerless soon" });
      const folderId = ((await created.json()) as { id: string }).id;
      expect((await send(world, "POST", `${FOLDERS}/${folderId}/shares`, as(cast.people.owner), { accountId: cast.people.direct.account.id })).status).toBe(201);
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE folders SET owner_id = NULL WHERE id = ${folderId}`;
      });

      expect((await request("direct", "GET", `${FOLDERS}/${folderId}`)).status).toBe(200);
      expect(await outcomeOf(await request("direct", "GET", `${FOLDERS}/${folderId}/shares`), [200])).toBe("forbidden");
      expect((await request("none", "GET", `${FOLDERS}/${folderId}`)).status).toBe(404);
      expect(await outcomeOf(await request("none", "GET", `${FOLDERS}/${folderId}/shares`), [200])).toBe("not_found");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("what a recipient sees of the owner's own things", () => {
  const RECIPIENTS = ["direct", "team", "folder"] as const;

  it.each(RECIPIENTS)(
    "%s: the bookmark carries none of the owner's tags, folders or pin, and the tag is not theirs to list, find, rename, merge or delete",
    async (relation) => {
      const { leak, tag } = cast;
      const read = (await (await request(relation, "GET", `${BOOKMARKS}/${leak.id}`)).json()) as Hit & { sharedVia: string; owner: { accountId: string } };
      expect(read).toMatchObject({ pinned: false, tags: [], folders: [], owner: { accountId: cast.people.owner.account.id } });

      const listed = (await (await request(relation, "GET", `${BOOKMARKS}?scope=shared_with_me&limit=100`)).json()) as { items: Hit[] };
      const inList = listed.items.find((item) => item.id === leak.id);
      expect(inList).toMatchObject({ pinned: false, tags: [], folders: [] });

      const found = (await (await request(relation, "GET", `${SEARCH}?q=${leak.slug}`)).json()) as { bookmarks: Hit[]; tags: unknown[]; folders: unknown[] };
      expect(found.bookmarks.find((hit) => hit.id === leak.id)).toMatchObject({ pinned: false });
      const byName = (await (await request(relation, "GET", `${SEARCH}?q=${PRIVATE_TAG}`)).json()) as { tags: unknown[]; folders: unknown[] };
      expect(byName.tags).toEqual([]);

      expect(((await (await request(relation, "GET", TAGS)).json()) as { items: unknown[] }).items).toEqual([]);
      const byTag = await request(relation, "GET", `${BOOKMARKS}?tag=${tag}`);
      expect(byTag.status).toBe(200);
      expect(((await byTag.json()) as { items: unknown[] }).items).toEqual([]);

      const refused = [
        await request(relation, "PATCH", `${TAGS}/${tag}`, { name: "mine" }),
        await request(relation, "POST", `${TAGS}/${tag}/merge`, { intoTagId: tag }),
        await request(relation, "DELETE", `${TAGS}/${tag}`),
      ];
      expect(refused.map((response) => response.status)).toEqual([404, 404, 404]);
      for (const response of refused) {
        expect(((await response.json()) as Problem).code).toBe("not_found");
      }

      // The shared folder shows its owner and no more: a recipient of the folder lists it, and the share summary is the owner's alone.
      if (relation === "folder") {
        const folders = (await (await request(relation, "GET", `${FOLDERS}?scope=shared`)).json()) as { items: { id: string; shareSummary: unknown }[] };
        expect(folders.items.find((item) => item.id === cast.sharedFolder)?.shareSummary).toBeNull();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
