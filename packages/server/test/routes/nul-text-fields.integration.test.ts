import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, WORKSPACE, WORKSPACES, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// A NUL character in a text field the API stores (doc 04 section 2.3): PostgreSQL cannot store U+0000 in a text column, so the request
// schemas refuse it with 422 validation_failed, through the whole chain over the migrated database, instead of letting the database fail
// the write with a server error. Nothing is written by a refused request.

const TEST_TIMEOUT_MS = 60_000;
const NUL = "\u0000";

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
  readonly errors?: readonly { readonly path: string }[];
}

async function expectRefused(response: Response, path: string): Promise<void> {
  expect(response.status).toBe(422);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const problem = (await response.json()) as Problem;
  expect(problem.code).toBe("validation_failed");
  expect(problem.errors?.map((error) => error.path)).toContain(path);
}

async function counts(): Promise<Record<string, number>> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const [row] = await tx<Record<string, string>[]>`
      SELECT (SELECT count(*) FROM bookmarks)::text AS bookmarks, (SELECT count(*) FROM folders)::text AS folders,
             (SELECT count(*) FROM tags)::text AS tags, (SELECT count(*) FROM workspaces)::text AS workspaces`;
    return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));
  });
}

async function setup(world: World): Promise<{ owner: Person }> {
  const owner = await harness.person(world);
  await harness.workspaceOf([{ person: owner, role: "owner" }]);
  return { owner };
}

const BOOKMARK = { url: "https://example.com/page", title: "Title" };

describe("a NUL character in a stored text field", () => {
  it.each([
    ["the title of a new bookmark", "title", { ...BOOKMARK, title: `a${NUL}b` }],
    ["the description of a new bookmark", "description", { ...BOOKMARK, description: `a${NUL}b` }],
    ["a tag name of a new bookmark", "tagNames.0", { ...BOOKMARK, tagNames: [`a${NUL}b`] }],
    ["the slug of a new bookmark", "slug", { ...BOOKMARK, slug: `a${NUL}b` }],
    ["the URL of a new bookmark", "url", { ...BOOKMARK, url: `https://example.com/a${NUL}b` }],
  ])("is refused with 422 in %s, and nothing is written", async (_name, path, body) => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const before = await counts();

    await expectRefused(await send(world, "POST", "/api/v1/bookmarks", { cookie: owner.cookie }, body), path);

    expect(await counts()).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it.each([
    ["the title of a changed bookmark", "title", { title: `a${NUL}b` }],
    ["the description of a changed bookmark", "description", { description: `a${NUL}b` }],
    ["a tag name of a changed bookmark", "tagNames.0", { tagNames: [`a${NUL}b`] }],
    ["the slug of a changed bookmark", "slug", { slug: `a${NUL}b` }],
    ["the URL of a changed bookmark", "url", { url: `https://example.com/a${NUL}b` }],
  ])("is refused with 422 in %s, and the bookmark is left as it was", async (_name, path, body) => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await send(world, "POST", "/api/v1/bookmarks", { cookie: owner.cookie }, BOOKMARK);
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const before = await counts();

    await expectRefused(await send(world, "PATCH", `/api/v1/bookmarks/${id}`, { cookie: owner.cookie }, body), path);

    expect(await counts()).toEqual(before);
    const read = await send(world, "GET", `/api/v1/bookmarks/${id}`, { cookie: owner.cookie });
    expect(((await read.json()) as { title: string }).title).toBe("Title");
  }, TEST_TIMEOUT_MS);

  it("is refused with 422 in the name of a new folder and of a changed folder", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    await expectRefused(await send(world, "POST", "/api/v1/folders", { cookie: owner.cookie }, { name: `a${NUL}b` }), "name");
    const made = await send(world, "POST", "/api/v1/folders", { cookie: owner.cookie }, { name: "Kept" });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };

    await expectRefused(await send(world, "PATCH", `/api/v1/folders/${id}`, { cookie: owner.cookie }, { name: `a${NUL}b` }), "name");

    expect((await counts()).folders).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("is refused with 422 in the name of a new tag and of a renamed tag", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    await expectRefused(await send(world, "POST", "/api/v1/tags", { cookie: owner.cookie }, { name: `a${NUL}b` }), "name");
    const made = await send(world, "POST", "/api/v1/tags", { cookie: owner.cookie }, { name: "Kept" });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };

    await expectRefused(await send(world, "PATCH", `/api/v1/tags/${id}`, { cookie: owner.cookie }, { name: `a${NUL}b` }), "name");

    expect((await counts()).tags).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("is refused with 422 in the name of a new workspace and of a renamed workspace", async () => {
    const world = harness.serve({ allowWorkspaceCreation: true });
    const { owner } = await setup(world);
    const before = await counts();

    await expectRefused(await send(world, "POST", WORKSPACES, { cookie: owner.cookie }, { name: `a${NUL}b` }), "name");
    await expectRefused(await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie }, { name: `a${NUL}b` }), "name");

    expect(await counts()).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it("is refused with 422 in the display name of the account", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    await expectRefused(await send(world, "PATCH", "/api/v1/me", { cookie: owner.cookie }, { displayName: `a${NUL}b` }), "displayName");
  }, TEST_TIMEOUT_MS);

  it("is never a server error in a bulk request by filter, the list, the folder search or the slug check", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const bulk = await send(world, "POST", "/api/v1/bookmarks/bulk", { cookie: owner.cookie }, { action: "pin", filter: { url: `https://example.com/a${NUL}b` } });
    expect(bulk.status).toBe(422);
    for (const path of [`/api/v1/bookmarks?url=${encodeURIComponent(`https://example.com/a${NUL}b`)}`, `/api/v1/bookmarks?q=${encodeURIComponent(`a${NUL}b`)}`, `/api/v1/folders?q=${encodeURIComponent(`a${NUL}b`)}`, `/api/v1/bookmarks/slug-availability?slug=${encodeURIComponent(`a${NUL}b`)}`]) {
      const response = await send(world, "GET", path, { cookie: owner.cookie });
      expect(response.status, path).toBeLessThan(500);
    }
  }, TEST_TIMEOUT_MS);

  it("is refused with 422 in the name of a new API token", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    await expectRefused(await send(world, "POST", "/api/v1/me/api-tokens", { cookie: owner.cookie }, { name: `a${NUL}b`, scope: "read" }), "name");
  }, TEST_TIMEOUT_MS);
});
