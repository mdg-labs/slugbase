import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageStore, type OpenCount } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsageBuffer, type UsageBuffer } from "../../src/usage/buffer.ts";
import { appUrl } from "../contract/support.ts";
import { recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /go/<slug> (doc 02 section 6.2, doc 04 section 9.3, doc 08 section 3.5 `go/resolution`, doc 10 T1, T2, T12 and residual 3), through the whole chain over the
// migrated database. The failure scenario (T12): a bookmark whose stored address is not an http or https URL, written through the owner connection because the
// application never writes one, is never redirected to, and nothing after the slug (a path, a query string) is appended to or forwarded to a destination.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const CHOOSE = "/api/v1/go/choose";
const SHELL = "<!doctype html><html><head><title>SlugBase shell</title></head><body><div id=\"root\"></div></body></html>";

const database = useTestDatabase();
const harness = workspaceHarness(database);
let webRoot: string;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "slugbase-go-navigation-"));
  writeFileSync(join(webRoot, "index.html"), SHELL);
  await harness.start();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Bookmark {
  readonly id: string;
}

function observedBuffer(): { readonly usage: UsageBuffer; readonly written: OpenCount[][]; readonly close: () => Promise<void> } {
  const store = createUsageStore({ url: appUrl(database()), poolSize: 2 });
  const written: OpenCount[][] = [];
  const usage = createUsageBuffer({
    store: {
      flush: (opens) => {
        written.push([...opens]);
        return store.flush(opens);
      },
      close: () => store.close(),
    },
    logger: recordingLogger(),
  });
  return { usage, written, close: () => store.close() };
}

/** A navigation: a GET of the path, which a browser makes without a body, an origin or a content type. */
function visit(world: World, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return world.server.fetch(new Request(new URL(path, world.origin), { method: "GET", headers: { accept: "text/html", ...headers } }));
}

async function created(world: World, as: Person, title: string, slug: string | undefined, forwarding?: boolean): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...(slug === undefined ? {} : { slug }), ...(forwarding === undefined ? {} : { forwarding }) });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function inDatabase(statement: string, params: string[] = []): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx.unsafe(statement, params);
  });
}

async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: member, role: "member" },
  ]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

function expectNavigationHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

async function expectShell(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  expectNavigationHeaders(response);
  expect(await response.text()).toBe(SHELL);
}

describe("GET /go/<slug> without a session", () => {
  it(
    "sends the browser to sign in and back to the same address, whether the slug exists or not",
    async () => {
      const world = harness.serve({ webRoot });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");

      for (const slug of ["mail", "nothing-here"]) {
        const response = await visit(world, `/go/${slug}`);
        expect(response.status, slug).toBe(302);
        expect(response.headers.get("location"), slug).toBe(`/login?returnTo=/go/${slug}`);
        expectNavigationHeaders(response);
      }
      expect((await visit(world, "/go/MAIL")).headers.get("location")).toBe("/login?returnTo=/go/mail");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "carries no return address for a slug outside the grammar, a path or a query string after the slug, so nothing the visitor typed is sent on",
    async () => {
      const world = harness.serve({ webRoot });

      for (const path of ["/go/-mail", "/go/ma%20il", `/go/${"a".repeat(65)}`, "/go/mail/inbox", "/go/mail/", "/go/", "/go/mail?x=1", "/go/mail%2fx"]) {
        const response = await visit(world, path);
        expect(response.status, path).toBe(302);
        expect(response.headers.get("location"), path).toBe("/login");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends a partial session, whose second factor is still owed, to the second step with the same return address",
    async () => {
      const world = harness.serve({ webRoot });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");
      await inDatabase("UPDATE sessions SET level = 'partial' WHERE id = $1", [owner.sessionId]);

      const response = await visit(world, "/go/Mail", { cookie: owner.cookie });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/login/mfa?returnTo=/go/mail");
      expectNavigationHeaders(response);
      expect((await visit(world, "/go/mail/x", { cookie: owner.cookie })).headers.get("location")).toBe("/login/mfa");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /go/<slug> with an Authorization header", () => {
  it(
    "answers 401 for an API token of either scope, one nothing accepts and any other scheme, even with a session cookie beside it, and never redirects",
    async () => {
      const world = harness.serve({ webRoot });
      const { owner, shared } = await setup(world);
      await created(world, owner, "Mail", "mail");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      for (const [name, authorization] of [
        ["a read token", `Bearer ${readOnly}`],
        ["a read-write token", `Bearer ${readWrite}`],
        ["an unknown token", "Bearer sb_unknown"],
        ["basic credentials", "Basic dXNlcjpwYXNz"],
      ] as const) {
        for (const extra of [{}, { cookie: owner.cookie }] as Record<string, string>[]) {
          for (const path of ["/go/mail", "/go/nothing-here", "/go/mail/x"]) {
            const response = await visit(world, path, { authorization, ...extra });
            expect(response.status, `${name} ${path}`).toBe(401);
            expect(response.headers.get("location"), `${name} ${path}`).toBeNull();
            expect(response.headers.get("content-type"), `${name} ${path}`).toMatch(/^application\/problem\+json/);
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /go/<slug> for a signed-in member", () => {
  it(
    "forwards the caller's own bookmark with a 302, no referrer and no caching, and counts one use of it",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage, webRoot });
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      const response = await visit(world, "/go/mail", { cookie: owner.cookie });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://example.com/Mail");
      expectNavigationHeaders(response);
      expect(await response.text()).toBe("");
      expect((await visit(world, "/go/  MAIL", { cookie: owner.cookie })).headers.get("location")).toBe("https://example.com/Mail");
      // The router reads a segment decoded, so the address sent with its letters encoded is the same route, and it keeps the same headers.
      const encoded = await visit(world, "/%67o/%6dail", { cookie: owner.cookie });
      expect(encoded.status).toBe(302);
      expect(encoded.headers.get("location")).toBe("https://example.com/Mail");
      expectNavigationHeaders(encoded);
      await usage.flush();
      expect(written.flat().map((entry) => [entry.bookmarkId, entry.count])).toEqual([[mail.id, 3]]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "forwards the remembered choice, and keeps two members' bookmarks of one slug apart",
    async () => {
      const { usage, close } = observedBuffer();
      const world = harness.serve({ usage, webRoot });
      const { owner, member } = await setup(world);
      const mine = await created(world, owner, "Owner mail", "mail");
      await created(world, member, "Member mail", "mail");
      expect((await send(world, "POST", CHOOSE, { cookie: owner.cookie }, { slug: "mail", bookmarkId: mine.id, remember: true })).status).toBe(200);

      expect((await visit(world, "/go/mail", { cookie: owner.cookie })).headers.get("location")).toBe("https://example.com/Owner%20mail");
      expect((await visit(world, "/go/mail", { cookie: member.cookie })).headers.get("location")).toBe("https://example.com/Member%20mail");
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "allows a top-level navigation from another site: the session cookie is read and the member lands on their own destination (doc 10, residual 3)",
    async () => {
      const world = harness.serve({ webRoot });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");

      const response = await visit(world, "/go/mail", {
        cookie: owner.cookie,
        referer: "https://evil.example/page",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://example.com/Mail");
      expectNavigationHeaders(response);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the 404 shell for a slug that exists only in another workspace, does not forward, is plan-archived or is another member's private bookmark, and counts nothing",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage, webRoot });
      const { owner, member, stranger } = await setup(world);
      await created(world, stranger, "Only in B", "only-in-b");
      await created(world, owner, "Paused", "paused", false);
      const archived = await created(world, owner, "Archived", "archived");
      await inDatabase("UPDATE bookmarks SET plan_archived_at = now() WHERE id = $1", [archived.id]);
      await created(world, member, "Private", "private");

      for (const slug of ["only-in-b", "paused", "archived", "private", "never-made"]) {
        await expectShell(await visit(world, `/go/${slug}`, { cookie: owner.cookie }), 404);
      }
      await usage.flush();
      expect(written).toEqual([]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the 404 shell for a slug outside the grammar and for anything after the slug, and never appends it to the destination",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage, webRoot });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");

      for (const path of ["/go/mail/PROJ-12", "/go/mail/", "/go/mail/a/b", "/go/mail?x=1", "/go/mail?x=1&y=2", "/go/", "/go/-mail", "/go/ma%20il", `/go/${"a".repeat(65)}`, "/go/mail%2fx"]) {
        await expectShell(await visit(world, path, { cookie: owner.cookie }), 404);
      }
      await usage.flush();
      expect(written).toEqual([]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never redirects to a stored address that is not an http or https URL, however it is spelled, and answers the 404 shell",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage, webRoot });
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      // The application never writes such an address, and the table refuses it; the constraint is lifted for the row and put back.
      await database().owner`ALTER TABLE bookmarks DROP CONSTRAINT bookmarks_url_scheme_check`;
      try {
        for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "ftp://example.com/x", "//evil.example/x", "evil.example/x", "https://exa mple.com/"]) {
          await inDatabase("UPDATE bookmarks SET url = $2 WHERE id = $1", [mail.id, url]);
          const response = await visit(world, "/go/mail", { cookie: owner.cookie });
          await expectShell(response, 404);
        }
      } finally {
        await inDatabase("UPDATE bookmarks SET url = 'https://example.com/Mail' WHERE id = $1", [mail.id]);
        await database().owner`ALTER TABLE bookmarks ADD CONSTRAINT bookmarks_url_scheme_check CHECK (url ~* '^https?://')`;
      }
      await usage.flush();
      expect(written).toEqual([]);
      expect((await visit(world, "/go/mail", { cookie: owner.cookie })).headers.get("location")).toBe("https://example.com/Mail");
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the 404 shell to a member who has no workspace",
    async () => {
      const world = harness.serve({ webRoot });
      const loner = await harness.person(world);

      await expectShell(await visit(world, "/go/mail", { cookie: loner.cookie }), 404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 not_found as a problem where the composition serves no web build",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      const response = await visit(world, "/go/never-made", { cookie: owner.cookie });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
      expect(((await response.json()) as { code: string }).code).toBe("not_found");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the go rate bucket on GET /go/<slug>", () => {
  it(
    "limits a signed-in member per account and any caller per address, and says when to try again",
    async () => {
      const world = harness.serve({ webRoot, env: { RATE_LIMIT_GO_ACCOUNT: "2/min" } });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");

      expect((await visit(world, "/go/mail", { cookie: owner.cookie })).status).toBe(302);
      expect((await visit(world, "/go/never-made", { cookie: owner.cookie })).status).toBe(404);
      const limited = await visit(world, "/go/mail", { cookie: owner.cookie });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
      expect(limited.headers.get("location")).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes the limit per address before the session is looked at, for the path after a slug as well",
    async () => {
      const world = harness.serve({ webRoot, env: { RATE_LIMIT_GO_IP: "3/min" } });

      expect((await visit(world, "/go/mail")).status).toBe(302);
      expect((await visit(world, "/go/mail/x")).status).toBe(302);
      expect((await visit(world, "/go/")).status).toBe(302);
      const limited = await visit(world, "/go/mail");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
