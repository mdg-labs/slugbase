import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

/**
 * Mandatory cross-workspace isolation suite (eng §6, spec §4.4).
 *
 * User owns workspace A and B; session activates A; HTTP access to B-owned
 * bookmark/folder/tag IDs must be denied (404 from query scoping or 403).
 */
describe("Workspace isolation (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let ownerUserId: string;
  let workspaceAId: string;
  let workspaceA: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;
  let workspaceB: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  let bookmarkInBId: string;
  let folderInBId: string;
  let tagInBId: string;

  const OWNER_EMAIL = "isolation-owner@example.com";
  const PASSWORD = "isolation-test-password-abc-123";

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
    const workspacesService = moduleRef.get(WorkspacesService);
    const bookmarksService = moduleRef.get(BookmarksService);
    const foldersService = moduleRef.get(FoldersService);
    const tagsService = moduleRef.get(TagsService);

    const owner = await accountsService.registerAccount({
      email: OWNER_EMAIL,
      name: "Isolation Owner",
      password: PASSWORD,
    });
    ownerUserId = owner.id;

    const wsA = await workspacesService.createWorkspace(
      { name: "Workspace A", slug: "workspace-a" },
      ownerUserId,
    );
    workspaceAId = wsA.id;
    workspaceA = wsA;

    const wsB = await workspacesService.createWorkspace(
      { name: "Workspace B", slug: "workspace-b" },
      ownerUserId,
    );
    workspaceB = wsB;

    const bookmarkB = await bookmarksService.createBookmark(workspaceB, ownerUserId, {
      title: "Bookmark in B",
      url: "https://b.example.com",
    });
    bookmarkInBId = bookmarkB.id;

    const folderB = await foldersService.createFolder(workspaceB, ownerUserId, {
      name: "Folder in B",
    });
    folderInBId = folderB.id;

    const tagB = await tagsService.createTag(workspaceB, ownerUserId, {
      name: "tag-in-b",
    });
    tagInBId = tagB.id;
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
    sessionCookie: string,
  ): Promise<{ token: string; cookie: string }> {
    const res = await request(server())
      .get("/auth/csrf-token")
      .set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
    const body = res.body as { csrfToken: string };
    const cookies = (res.headers["set-cookie"] as string[] | string | undefined) ?? [];
    const jar = Array.isArray(cookies) ? cookies : [cookies];
    const csrfCookieStr = jar.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
    return { token: body.csrfToken, cookie: csrfCookieStr };
  }

  async function activateWorkspace(
    sessionCookie: string,
    csrf: { token: string; cookie: string },
    workspaceId: string,
  ): Promise<void> {
    const res = await request(server())
      .post(`/workspaces/${workspaceId}/activate`)
      .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
      .set("x-csrf-token", csrf.token)
      .send();
    expect(res.status).toBe(200);
  }

  describe("active workspace A - resources in B are inaccessible", () => {
    let sessionCookie: string;
    let csrfToken: string;
    let csrfCookie: string;

    beforeAll(async () => {
      sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);
      csrfToken = csrf.token;
      csrfCookie = csrf.cookie;
      await activateWorkspace(sessionCookie, csrf, workspaceAId);
    });

    function authHeaders(): { Cookie: string; "x-csrf-token": string } {
      return {
        Cookie: `${sessionCookie}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
      };
    }

    it("denies read of a bookmark that belongs to workspace B", async () => {
      const res = await request(server())
        .get(`/bookmarks/${bookmarkInBId}`)
        .set("Cookie", sessionCookie);
      expect([403, 404]).toContain(res.status);
    });

    it("denies update of a bookmark that belongs to workspace B", async () => {
      const res = await request(server())
        .patch(`/bookmarks/${bookmarkInBId}`)
        .set(authHeaders())
        .send({ title: "Cross-workspace hijack" });
      expect([403, 404]).toContain(res.status);
    });

    it("denies delete of a bookmark that belongs to workspace B", async () => {
      const res = await request(server())
        .delete(`/bookmarks/${bookmarkInBId}`)
        .set(authHeaders());
      expect([403, 404]).toContain(res.status);
    });

    it("denies read of a folder that belongs to workspace B", async () => {
      const res = await request(server())
        .get(`/folders/${folderInBId}`)
        .set("Cookie", sessionCookie);
      expect([403, 404]).toContain(res.status);
    });

    it("denies update of a folder that belongs to workspace B", async () => {
      const res = await request(server())
        .patch(`/folders/${folderInBId}`)
        .set(authHeaders())
        .send({ name: "Cross-workspace folder" });
      expect([403, 404]).toContain(res.status);
    });

    it("denies delete of a folder that belongs to workspace B", async () => {
      const res = await request(server())
        .delete(`/folders/${folderInBId}`)
        .set(authHeaders());
      expect([403, 404]).toContain(res.status);
    });

    it("denies read of a tag that belongs to workspace B", async () => {
      const res = await request(server())
        .get(`/tags/${tagInBId}`)
        .set("Cookie", sessionCookie);
      expect([403, 404]).toContain(res.status);
    });

    it("denies update of a tag that belongs to workspace B", async () => {
      const res = await request(server())
        .patch(`/tags/${tagInBId}`)
        .set(authHeaders())
        .send({ name: "cross-ws-tag" });
      expect([403, 404]).toContain(res.status);
    });

    it("denies delete of a tag that belongs to workspace B", async () => {
      const res = await request(server())
        .delete(`/tags/${tagInBId}`)
        .set(authHeaders());
      expect([403, 404]).toContain(res.status);
    });

    it("does not list workspace B bookmarks while workspace A is active", async () => {
      const res = await request(server())
        .get("/bookmarks")
        .set("Cookie", sessionCookie);
      expect(res.status).toBe(200);
      const body = res.body as { items: { id: string }[] };
      const ids = body.items.map((item) => item.id);
      expect(ids).not.toContain(bookmarkInBId);
    });

    it("stamps new bookmarks with the active workspace A", async () => {
      const res = await request(server())
        .post("/bookmarks")
        .set(authHeaders())
        .send({
          title: "Created in A",
          url: "https://a.example.com/new",
        });
      expect(res.status).toBe(201);
      const body = res.body as { workspaceId: string };
      expect(body.workspaceId).toBe(workspaceA.id);
    });
  });
});
