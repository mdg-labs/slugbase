import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
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
    await runMigrations(testDatabase.databaseUrl);
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

      const prefs = await goService.listPreferences(workspace, ownerUserId);
      expect(prefs.some((p) => p.slug === "choose-me" && p.bookmarkId === chosen.id)).toBe(
        true,
      );

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
      const listBody = listRes.body as { items: Array<{ id: string; slug: string }> };
      expect(listBody.items.some((item) => item.id === created.id)).toBe(true);

      const deleteRes = await request(server())
        .delete(`/go/preferences/${created.id}`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken);
      expect(deleteRes.status).toBe(204);

      const afterDelete = await goService.listPreferences(workspace, ownerUserId);
      expect(afterDelete.some((item) => item.id === created.id)).toBe(false);
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
