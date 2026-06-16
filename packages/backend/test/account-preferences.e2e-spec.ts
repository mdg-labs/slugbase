import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

const TEST_EMAIL = "prefs-user@example.com";
const TEST_PASSWORD = "prefs-password-abc-123";
const TEST_NAME = "Preferences User";

function extractSessionCookie(
  setCookie: string[] | string | undefined,
): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const sessionCookieHeader = cookies.find((c) =>
    c.startsWith(`${SESSION_COOKIE}=`),
  );
  expect(sessionCookieHeader).toBeDefined();
  return sessionCookieHeader?.split(";")[0] ?? "";
}

describe("Account preferences onboarding state (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

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
    const account = await accountsService.registerAccount({
      email: TEST_EMAIL,
      name: TEST_NAME,
      password: TEST_PASSWORD,
    });
    await workspacesService.createWorkspace(
      {
        name: `${TEST_NAME}'s workspace`,
        slug: "prefs-user-ws",
        plan: "free",
      },
      account.id,
    );
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

  async function loginAndCsrf(): Promise<{
    sessionCookie: string;
    csrfToken: string;
    csrfCookie: string;
  }> {
    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(loginRes.status).toBe(200);
    const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const csrfRes = await request(server())
      .get("/auth/csrf-token")
      .set("Cookie", sessionCookie);
    expect(csrfRes.status).toBe(200);
    const csrfToken = (csrfRes.body as { csrfToken: string }).csrfToken;
    const csrfCookie =
      (csrfRes.headers["set-cookie"] as string[] | undefined)
        ?.find((c) => c.startsWith("csrf_token="))
        ?.split(";")[0] ?? "";
    return { sessionCookie, csrfToken, csrfCookie };
  }

  it("returns default onboarding state from GET /auth/me", async () => {
    const { sessionCookie } = await loginAndCsrf();
    const meRes = await request(server())
      .get("/auth/me")
      .set("Cookie", sessionCookie);
    expect(meRes.status).toBe(200);
    const body = meRes.body as {
      onboardingCompletedAt: number | null;
      dashboardChecklistDismissed: boolean;
      dashboardChecklistManual: Record<string, boolean>;
    };
    expect(body.onboardingCompletedAt).toBeNull();
    expect(body.dashboardChecklistDismissed).toBe(false);
    expect(body.dashboardChecklistManual).toEqual({
      import: false,
      browser_shortcut: false,
      folder: false,
      tag: false,
    });
  });

  it("round-trips onboarding and checklist preferences via PATCH /auth/account/preferences", async () => {
    const { sessionCookie, csrfToken, csrfCookie } = await loginAndCsrf();

    const patchRes = await request(server())
      .patch("/auth/account/preferences")
      .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
      .set("x-csrf-token", csrfToken)
      .send({
        onboardingCompleted: true,
        dashboardChecklistDismissed: true,
        dashboardChecklistManual: { import: true, browser_shortcut: true },
      });
    expect(patchRes.status).toBe(200);
    const patched = patchRes.body as {
      onboardingCompletedAt: number | null;
      dashboardChecklistDismissed: boolean;
      dashboardChecklistManual: Record<string, boolean>;
    };
    expect(patched.onboardingCompletedAt).toEqual(expect.any(Number));
    expect(patched.dashboardChecklistDismissed).toBe(true);
    expect(patched.dashboardChecklistManual).toEqual({
      import: true,
      browser_shortcut: true,
      folder: false,
      tag: false,
    });

    const meRes = await request(server())
      .get("/auth/me")
      .set("Cookie", sessionCookie);
    expect(meRes.status).toBe(200);
    const meBody = meRes.body as {
      onboardingCompletedAt: number | null;
      dashboardChecklistDismissed: boolean;
      dashboardChecklistManual: Record<string, boolean>;
    };
    expect(meBody.onboardingCompletedAt).toBe(patched.onboardingCompletedAt);
    expect(meBody.dashboardChecklistDismissed).toBe(true);
    expect(meBody.dashboardChecklistManual.import).toBe(true);
    expect(meBody.dashboardChecklistManual.browser_shortcut).toBe(true);
  });
});
