import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarkRepository } from "../src/bookmarks/bookmark.repository.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { DbService } from "../src/db/db.service.js";
import { GoService } from "../src/slugs/go.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Slugs + /go (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let bookmarksService: BookmarksService;
  let goService: GoService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;
  let dbService: DbService;

  let ownerUserId: string;
  let memberUserId: string;
  let workspaceId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  let sessionCookie: string;
  let csrfToken: string;
  let csrfCookie: string;

  const OWNER_EMAIL = "go-owner@example.com";
  const MEMBER_EMAIL = "go-member@example.com";
  const PASSWORD = "go-test-password-abc-123";

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    bookmarksService = moduleRef.get(BookmarksService);
    goService = moduleRef.get(GoService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);
    dbService = moduleRef.get(DbService);

    const owner = await accountsService.registerAccount({
      email: OWNER_EMAIL,
      name: "Go Owner",
      password: PASSWORD,
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: MEMBER_EMAIL,
      name: "Go Member",
      password: PASSWORD,
    });
    memberUserId = member.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Go Workspace", slug: "go-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;
    workspace = ws;

    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);

    sessionCookie = await loginAs(OWNER_EMAIL);
    const csrf = await fetchCsrfToken(sessionCookie);
    csrfToken = csrf.token;
    csrfCookie = csrf.cookie;

    await request(server())
      .post(`/workspaces/${workspaceId}/activate`)
      .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
      .set("x-csrf-token", csrfToken)
      .send();
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  function server(): Server {
    if (!app) throw new Error("app not initialized");
    return app.getHttpServer() as Server;
  }

  async function loginAs(email: string): Promise<string> {
    const res = await request(server())
      .post("/auth/login")
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookies = (res.headers["set-cookie"] as string[] | string | undefined) ?? [];
    const jar = Array.isArray(cookies) ? cookies : [cookies];
    const sessionCookieStr = jar.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
    expect(sessionCookieStr).toBeTruthy();
    return sessionCookieStr ?? "";
  }

  async function fetchCsrfToken(
    cookie: string,
  ): Promise<{ token: string; cookie: string }> {
    const res = await request(server()).get("/auth/csrf-token").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const body = res.body as { csrfToken: string };
    const cookies = (res.headers["set-cookie"] as string[] | string | undefined) ?? [];
    const jar = Array.isArray(cookies) ? cookies : [cookies];
    const csrfCookieStr = jar.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
    return { token: body.csrfToken, cookie: csrfCookieStr };
  }

  describe("slug validation", () => {
    it("rejects reserved slugs on bookmark create", async () => {
      await expect(
        bookmarksService.createBookmark(workspace, ownerUserId, {
          title: "Reserved Route",
          url: "https://reserved.example.com",
          slug: "go",
          forwardingEnabled: true,
        }),
      ).rejects.toThrow('Slug "go" is reserved');
    });

    it("rejects javascript: URLs on bookmark create", async () => {
      await expect(
        bookmarksService.createBookmark(workspace, ownerUserId, {
          title: "XSS Attempt",
          url: "javascript:alert(1)",
        }),
      ).rejects.toThrow("Only http and https URLs are supported");
    });
  });

  describe("GET /go/:slug", () => {
    it("redirects on a single forwarding match", async () => {
      await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "React Docs",
        url: "https://react.dev",
        slug: "react",
        forwardingEnabled: true,
      });

      const res = await request(server())
        .get("/go/react")
        .set("Cookie", sessionCookie)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://react.dev");
    });

    it("returns 404 when no forwarding bookmark matches", async () => {
      const res = await request(server())
        .get("/go/does-not-exist")
        .set("Cookie", sessionCookie);

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await request(server()).get("/go/react");
      expect(res.status).toBe(401);
    });

    it("returns 400 when stored bookmark URL is not http or https", async () => {
      const bookmarkRepo = new BookmarkRepository(dbService.getOrm());
      await bookmarkRepo.create(workspaceId, ownerUserId, {
        title: "Legacy bad URL",
        url: "javascript:alert(1)",
        slug: "bad-redirect-url",
        forwardingEnabled: true,
      });

      const res = await request(server())
        .get("/go/bad-redirect-url")
        .set("Cookie", sessionCookie);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        message: "Only http and https URLs are supported",
      });
    });

    it("returns disambiguation when multiple accessible matches exist", async () => {
      const first = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "First Docs",
        url: "https://first.example.com",
        slug: "ambig",
        forwardingEnabled: true,
      });
      const second = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Second Docs",
        url: "https://second.example.com",
        slug: "ambig-other",
        forwardingEnabled: true,
      });

      const repo = goService.getRepository();
      const spy = vi.spyOn(repo, "findAccessibleForwardingMatches").mockResolvedValue([
        first,
        { ...second, slug: "ambig" },
      ]);

      const res = await request(server())
        .get("/go/ambig")
        .set("Cookie", sessionCookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        kind: string;
        slug: string;
        candidates: Array<{ id: string; url: string }>;
      };
      expect(body.kind).toBe("disambiguation");
      expect(body.slug).toBe("ambig");
      expect(body.candidates).toHaveLength(2);

      spy.mockRestore();
    });

    it("honors a remembered slug preference over disambiguation", async () => {
      const preferred = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Preferred Target",
        url: "https://preferred.example.com",
        slug: "pref-slug",
        forwardingEnabled: true,
      });
      const alternate = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Alternate Target",
        url: "https://alternate.example.com",
        slug: "pref-slug-alt",
        forwardingEnabled: true,
      });

      await goService.getRepository().upsertSlugPreference({
        workspaceId: workspaceId,
        userId: ownerUserId,
        slug: "pref-slug",
        bookmarkId: preferred.id,
      });

      const repo = goService.getRepository();
      const spy = vi.spyOn(repo, "findAccessibleForwardingMatches").mockResolvedValue([
        preferred,
        { ...alternate, slug: "pref-slug" },
      ]);

      const res = await request(server())
        .get("/go/pref-slug")
        .set("Cookie", sessionCookie)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://preferred.example.com");

      spy.mockRestore();
    });
  });

  describe("POST /go/:slug/choose + preferences", () => {
    it("stores a preference and redirects when remember is true", async () => {
      const chosen = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Choose Target",
        url: "https://chosen.example.com",
        slug: "choose-me",
        forwardingEnabled: true,
      });
      const alternate = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Alternate",
        url: "https://alternate-choose.example.com",
        slug: "choose-alt",
        forwardingEnabled: true,
      });

      const repo = goService.getRepository();
      const spy = vi.spyOn(repo, "findAccessibleForwardingMatches").mockResolvedValue([
        chosen,
        { ...alternate, slug: "choose-me" },
      ]);

      const res = await request(server())
        .post("/go/choose-me/choose")
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send({ bookmarkId: chosen.id, remember: true })
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://chosen.example.com");

      const listRes = await request(server())
        .get("/go/preferences")
        .set("Cookie", sessionCookie);
      expect(listRes.status).toBe(200);
      const listBody = listRes.body as {
        items: Array<{
          slug: string;
          bookmarkId: string;
          bookmarkTitle: string;
          bookmarkUrl: string;
          ownerUserId: string;
          isAmbiguous: boolean;
        }>;
      };
      const item = listBody.items.find(
        (entry) => entry.slug === "choose-me" && entry.bookmarkId === chosen.id,
      );
      expect(item).toBeDefined();
      expect(item?.bookmarkTitle).toBe("Choose Target");
      expect(item?.bookmarkUrl).toBe("https://chosen.example.com");
      expect(item?.ownerUserId).toBe(ownerUserId);
      expect(item?.isAmbiguous).toBe(true);

      spy.mockRestore();
    });

    it("lists and removes slug preferences", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Pref List",
        url: "https://pref-list.example.com",
        slug: "pref-list",
        forwardingEnabled: true,
      });

      const created = await goService.getRepository().upsertSlugPreference({
        workspaceId: workspaceId,
        userId: ownerUserId,
        slug: "pref-list",
        bookmarkId: bookmark.id,
      });

      const listRes = await request(server())
        .get("/go/preferences")
        .set("Cookie", sessionCookie);
      expect(listRes.status).toBe(200);
      const listBody = listRes.body as {
        items: Array<{
          id: string;
          slug: string;
          bookmarkTitle: string;
          bookmarkUrl: string;
          ownerUserId: string;
          isAmbiguous: boolean;
        }>;
      };
      const listed = listBody.items.find((item) => item.id === created.id);
      expect(listed).toBeDefined();
      expect(listed?.slug).toBe("pref-list");
      expect(listed?.bookmarkTitle).toBe("Pref List");
      expect(listed?.bookmarkUrl).toBe("https://pref-list.example.com");
      expect(listed?.ownerUserId).toBe(ownerUserId);
      expect(listed?.isAmbiguous).toBe(false);

      const deleteRes = await request(server())
        .delete(`/go/preferences/${created.id}`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken);
      expect(deleteRes.status).toBe(204);

      const afterDelete = await goService.listPreferences(workspace, ownerUserId);
      expect(afterDelete.some((item) => item.id === created.id)).toBe(false);
    });
  });

  describe("slug preference auto-prune", () => {
    it("prunes a preference on resolve when only one match remains", async () => {
      const only = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Only Match",
        url: "https://only-match.example.com",
        slug: "prune-resolve",
        forwardingEnabled: true,
      });

      await goService.getRepository().upsertSlugPreference({
        workspaceId,
        userId: ownerUserId,
        slug: "prune-resolve",
        bookmarkId: only.id,
      });

      const before = await goService.listPreferences(workspace, ownerUserId);
      expect(before.some((p) => p.slug === "prune-resolve")).toBe(true);

      const result = await goService.resolveSlug(workspace, ownerUserId, "prune-resolve");
      expect(result.kind).toBe("redirect");

      const after = await goService.listPreferences(workspace, ownerUserId);
      expect(after.some((p) => p.slug === "prune-resolve")).toBe(false);
    });

    it("retains a preference while two accessible matches still exist", async () => {
      const first = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Prune Keep First",
        url: "https://prune-keep-first.example.com",
        slug: "prune-keep",
        forwardingEnabled: true,
      });
      const second = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Prune Keep Second",
        url: "https://prune-keep-second.example.com",
        slug: "prune-keep-alt",
        forwardingEnabled: true,
      });

      await goService.getRepository().upsertSlugPreference({
        workspaceId,
        userId: ownerUserId,
        slug: "prune-keep",
        bookmarkId: first.id,
      });

      const repo = goService.getRepository();
      const spy = vi.spyOn(repo, "findAccessibleForwardingMatches").mockResolvedValue([
        first,
        { ...second, slug: "prune-keep" },
      ]);

      await goService.reEvaluateSlugPreference(workspaceId, ownerUserId, "prune-keep");

      const prefs = await goService.listPreferences(workspace, ownerUserId);
      expect(prefs.some((p) => p.slug === "prune-keep")).toBe(true);

      spy.mockRestore();
    });

    it("prunes a preference when the preferred bookmark is deleted", async () => {
      const kept = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Kept Collision",
        url: "https://kept-collision.example.com",
        slug: "prune-delete",
        forwardingEnabled: true,
      });
      const removed = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Removed Collision",
        url: "https://removed-collision.example.com",
        slug: "prune-delete-alt",
        forwardingEnabled: true,
      });

      await goService.getRepository().upsertSlugPreference({
        workspaceId,
        userId: ownerUserId,
        slug: "prune-delete",
        bookmarkId: removed.id,
      });

      const repo = goService.getRepository();
      const spy = vi.spyOn(repo, "findAccessibleForwardingMatches").mockResolvedValue([
        kept,
        { ...removed, slug: "prune-delete" },
      ]);
      await goService.reEvaluateSlugPreference(workspaceId, ownerUserId, "prune-delete");
      spy.mockRestore();

      const beforeDelete = await goService
        .getRepository()
        .listSlugPreferences(workspaceId, ownerUserId);
      expect(beforeDelete.some((p) => p.slug === "prune-delete")).toBe(true);

      await bookmarksService.deleteBookmark(workspace, ownerUserId, removed.id);

      const afterDelete = await goService.listPreferences(workspace, ownerUserId);
      expect(afterDelete.some((p) => p.slug === "prune-delete")).toBe(false);
    });
  });

  describe("async usage tracking", () => {
    it("increments access count after redirect", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Usage Slug",
        url: "https://usage-slug.example.com",
        slug: "usage-slug",
        forwardingEnabled: true,
      });

      await request(server())
        .get("/go/usage-slug")
        .set("Cookie", sessionCookie)
        .redirects(0);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const updated = await bookmarksService.getBookmark(
        workspace,
        ownerUserId,
        bookmark.id,
      );
      expect(updated.accessCount).toBeGreaterThanOrEqual(1);
    });
  });
});
