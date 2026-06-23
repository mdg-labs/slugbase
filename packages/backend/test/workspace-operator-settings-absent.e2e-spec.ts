import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { SESSION_COOKIE } from "../src/sessions/session-constants.js";
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

type OpenApiDocument = {
  paths: Record<string, unknown>;
};

/** Operator-managed mail/OIDC admin routes removed in v1 (spec §10.1, §11.1, §11.3). */
const REMOVED_WORKSPACE_OPERATOR_PATHS = [
  "/workspace/settings/mail",
  "/workspace/settings/mail/test",
  "/workspace/settings/oidc/providers",
  "/workspace/settings/oidc/providers/{providerId}",
] as const;

describe("Workspace operator mail/OIDC admin absent (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let adminSessionCookie: string;

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
    const sessions = moduleRef.get(SessionService);

    const adminUser = await accountsService.registerAccount({
      email: "operator-absent-admin@example.com",
      name: "Operator Absent Admin",
      password: "password-abc-123",
    });

    const workspace = await workspacesService.createWorkspace(
      { name: "Operator Absent WS", slug: "operator-absent-ws", plan: "free" },
      adminUser.id,
    );

    const adminSession = await sessions.createSession({
      userId: adminUser.id,
      data: { activeWorkspaceId: workspace.id },
    });
    adminSessionCookie = `${SESSION_COOKIE}=${adminSession.cookieValue}`;
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

  it("does not list removed workspace mail/OIDC admin paths in OpenAPI", async () => {
    const res = await request(server()).get("/openapi.json");
    expect(res.status).toBe(200);

    const document = res.body as OpenApiDocument;
    for (const path of REMOVED_WORKSPACE_OPERATOR_PATHS) {
      expect(document.paths[path]).toBeUndefined();
    }
  });

  it("still lists GET /auth/oidc/providers in OpenAPI (public login list)", async () => {
    const res = await request(server()).get("/openapi.json");
    expect(res.status).toBe(200);

    const document = res.body as OpenApiDocument;
    expect(document.paths["/auth/oidc/providers"]).toBeDefined();
  });

  it("returns 404 for removed workspace mail settings routes", async () => {
    const getRes = await request(server())
      .get("/workspace/settings/mail")
      .set("Cookie", adminSessionCookie);
    expect(getRes.status).toBe(404);

    const patchRes = await request(server())
      .patch("/workspace/settings/mail")
      .set("Cookie", adminSessionCookie)
      .send({ host: "smtp.test.com" });
    expect(patchRes.status).toBe(404);

    const testRes = await request(server())
      .post("/workspace/settings/mail/test")
      .set("Cookie", adminSessionCookie)
      .send({ to: "admin@example.com" });
    expect(testRes.status).toBe(404);
  });

  it("returns 404 for removed workspace OIDC provider admin routes", async () => {
    const listRes = await request(server())
      .get("/workspace/settings/oidc/providers")
      .set("Cookie", adminSessionCookie);
    expect(listRes.status).toBe(404);

    const createRes = await request(server())
      .post("/workspace/settings/oidc/providers")
      .set("Cookie", adminSessionCookie)
      .send({
        name: "Test",
        issuerUrl: "https://issuer.example.com",
        clientId: "client",
        clientSecret: "secret",
      });
    expect(createRes.status).toBe(404);

    const patchRes = await request(server())
      .patch("/workspace/settings/oidc/providers/prov-1")
      .set("Cookie", adminSessionCookie)
      .send({ name: "Updated" });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(server())
      .delete("/workspace/settings/oidc/providers/prov-1")
      .set("Cookie", adminSessionCookie);
    expect(deleteRes.status).toBe(404);
  });
});
