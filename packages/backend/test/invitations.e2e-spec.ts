import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MailService } from "@slugbase/shared-types";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { DbService } from "../src/db/db.service.js";
import { InvitationRepository } from "../src/invitations/invitation.repository.js";
import {
  InvitationsService,
  buildInvitationAcceptUrl,
  hashInvitationToken,
} from "../src/invitations/invitations.service.js";
import { MAIL } from "../src/mail/mail.tokens.js";
import { SESSION_COOKIE } from "../src/sessions/session-constants.js";
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv, validTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Invitations (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let invitationsService: InvitationsService;
  let workspacesService: WorkspacesService;
  let invitationRepo: InvitationRepository;
  let mailSend: ReturnType<typeof vi.fn>;
  let sessions: SessionService;

  let ownerUserId: string;
  let ownerSessionCookie: string;
  let ownerCsrfToken: string;
  let ownerCsrfCookie: string;
  let freeWorkspaceId: string;
  let personalWorkspaceId: string;
  let teamWorkspaceId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    mailSend = vi.fn().mockResolvedValue(undefined);

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAIL)
      .useValue({
        isAvailable: () => true,
        ensureAvailable: () => Promise.resolve(true),
        send: mailSend,
        sendTest: vi.fn().mockResolvedValue(undefined),
      } satisfies MailService)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    workspacesService = moduleRef.get(WorkspacesService);
    invitationsService = moduleRef.get(InvitationsService);
    sessions = moduleRef.get(SessionService);
    const db = moduleRef.get(DbService);
    invitationRepo = new InvitationRepository(db.getOrm());

    const owner = await accountsService.registerAccount({
      email: "invite-owner@example.com",
      name: "Invite Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const freeWs = await workspacesService.createWorkspace(
      { name: "Free Workspace", slug: "free-ws-invites", plan: "free" },
      ownerUserId,
    );
    freeWorkspaceId = freeWs.id;

    const personalWs = await workspacesService.createWorkspace(
      { name: "Personal Workspace", slug: "personal-ws-invites", plan: "personal" },
      ownerUserId,
    );
    personalWorkspaceId = personalWs.id;

    const teamWs = await workspacesService.createWorkspace(
      { name: "Team Workspace", slug: "team-ws-invites", plan: "team", planSeats: 10 },
      ownerUserId,
    );
    teamWorkspaceId = teamWs.id;

    const { cookieValue } = await sessions.createSession({
      userId: ownerUserId,
      data: { activeWorkspaceId: teamWorkspaceId },
    });
    const sessionCookieStr = `${SESSION_COOKIE}=${cookieValue}`;
    ownerSessionCookie = sessionCookieStr;

    const csrfRes = await request(app.getHttpServer() as Server)
      .get("/auth/csrf-token")
      .set("Cookie", sessionCookieStr);

    const body = csrfRes.body as { csrfToken: string };
    ownerCsrfToken = body.csrfToken;
    const setCookieHeader = csrfRes.headers["set-cookie"] as string[] | string | undefined;
    const csrfCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    ownerCsrfCookie = csrfCookies.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
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

  /** Extracts the plaintext token from a built invitation accept URL. */
  function extractInvitationToken(acceptUrl: string): string {
    const token = acceptUrl.split("/invitations/")[1];
    expect(token).toBeDefined();
    return token as string;
  }

  async function authForWorkspace(workspaceId: string): Promise<{
    sessionCookie: string;
    csrfToken: string;
    csrfCookie: string;
  }> {
    const { cookieValue } = await sessions.createSession({
      userId: ownerUserId,
      data: { activeWorkspaceId: workspaceId },
    });
    const sessionCookie = `${SESSION_COOKIE}=${cookieValue}`;
    const csrfRes = await request(server())
      .get("/auth/csrf-token")
      .set("Cookie", sessionCookie);
    const csrfBody = csrfRes.body as { csrfToken: string };
    const setCookieHeader = csrfRes.headers["set-cookie"] as string[] | string | undefined;
    const csrfCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    const csrfCookie =
      csrfCookies.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
    return {
      sessionCookie,
      csrfToken: csrfBody.csrfToken,
      csrfCookie,
    };
  }

  /** Creates an invitation with a known plaintext token directly via the repo. */
  async function createKnownInvitation(
    email: string,
    role: "ADMIN" | "MEMBER" = "MEMBER",
    workspaceId: string = teamWorkspaceId,
  ): Promise<{ plaintext: string }> {
    const plaintext = randomBytes(32).toString("hex");
    const tokenHash = hashInvitationToken(plaintext);
    await invitationRepo.create({
      workspaceId,
      invitedEmail: email,
      role,
      tokenHash,
      invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    return { plaintext };
  }

  // ---------------------------------------------------------------------------
  // AC5: Entitlement gate - free plan workspace returns 403
  // ---------------------------------------------------------------------------

  describe("POST /workspaces/:id/invitations - free plan on CE", () => {
    it("creates an invitation on free plan when billing is no-op", async () => {
      const res = await request(server())
        .post(`/workspaces/${freeWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "free-plan-invite@example.com", role: "MEMBER" });

      expect(res.status).toBe(201);
    });
  });

  describe("POST /workspaces/:id/invitations - personal plan on CE", () => {
    it("creates an invitation on personal plan when billing is no-op", async () => {
      const res = await request(server())
        .post(`/workspaces/${personalWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "personal-plan-invite@example.com", role: "MEMBER" });

      expect(res.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /workspaces/:id/invitations - team plan creates invitation
  // ---------------------------------------------------------------------------

  describe("POST /workspaces/:id/invitations - team plan creates invitation", () => {
    it("returns 201 with invitation metadata", async () => {
      const res = await request(server())
        .post(`/workspaces/${teamWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "created-invite@example.com", role: "MEMBER" });

      expect(res.status).toBe(201);
      const body = res.body as {
        id: string;
        workspaceId: string;
        invitedEmail: string;
        role: string;
        invitedByUserId: string;
        acceptedAt: null;
        expiresAt: string;
        createdAt: string;
      };
      expect(body.workspaceId).toBe(teamWorkspaceId);
      expect(body.invitedEmail).toBe("created-invite@example.com");
      expect(body.role).toBe("MEMBER");
      expect(body.invitedByUserId).toBe(ownerUserId);
      expect(body.acceptedAt).toBeNull();
      expect(typeof body.expiresAt).toBe("string");
    });

    it("returns 409 when a pending invitation already exists for the same email", async () => {
      const res = await request(server())
        .post(`/workspaces/${teamWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "created-invite@example.com", role: "MEMBER" });

      expect(res.status).toBe(409);
    });

    it("returns 401 when session is absent but CSRF is valid", async () => {
      const res = await request(server())
        .post(`/workspaces/${teamWorkspaceId}/invitations`)
        .set("Cookie", ownerCsrfCookie)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "noauth@example.com", role: "MEMBER" });

      expect(res.status).toBe(401);
    });

    it("sends email when delivery is email (default)", async () => {
      mailSend.mockClear();

      const res = await request(server())
        .post(`/workspaces/${teamWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "email-delivery@example.com", role: "MEMBER", delivery: "email" });

      expect(res.status).toBe(201);
      expect(mailSend).toHaveBeenCalledTimes(1);
      expect(mailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "email-delivery@example.com",
          type: "workspace_invitation",
        }),
      );
      const body = res.body as { acceptUrl?: string };
      expect(body.acceptUrl).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /workspaces/:id/invitations - link delivery
  // ---------------------------------------------------------------------------

  describe("POST /workspaces/:id/invitations - link delivery", () => {
    it("returns 201 with acceptUrl and does not send email", async () => {
      mailSend.mockClear();

      const res = await request(server())
        .post(`/workspaces/${teamWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "link-delivery@example.com", role: "MEMBER", delivery: "link" });

      expect(res.status).toBe(201);
      expect(mailSend).not.toHaveBeenCalled();

      const body = res.body as {
        id: string;
        invitedEmail: string;
        acceptUrl: string;
      };
      expect(body.invitedEmail).toBe("link-delivery@example.com");
      expect(body.acceptUrl).toBe(
        buildInvitationAcceptUrl({
          appBaseUrl: validTestEnv.APP_BASE_URL ?? "https://api.slugbase.test",
          frontendOrigin: validTestEnv.FRONTEND_ORIGIN ?? "https://app.slugbase.test",
          serveWebClient: false,
          token: extractInvitationToken(body.acceptUrl),
        }),
      );

      const token = extractInvitationToken(body.acceptUrl);
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const metadataRes = await request(server()).get(`/invitations/${token}`);
      expect(metadataRes.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /workspace/invitations/:id/link - copy link
  // ---------------------------------------------------------------------------

  describe("POST /workspace/invitations/:id/link - copy link", () => {
    it("returns acceptUrl, rotates token, and does not send email", async () => {
      mailSend.mockClear();

      const createRes = await request(server())
        .post(`/workspaces/${teamWorkspaceId}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "copy-link@example.com", role: "MEMBER", delivery: "link" });

      expect(createRes.status).toBe(201);
      const created = createRes.body as { id: string; acceptUrl: string };
      const originalToken = extractInvitationToken(created.acceptUrl);

      const linkRes = await request(server())
        .post(`/workspace/invitations/${created.id}/link`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken);

      expect(linkRes.status).toBe(200);
      expect(mailSend).not.toHaveBeenCalled();

      const linkBody = linkRes.body as { acceptUrl: string };
      const newToken = extractInvitationToken(linkBody.acceptUrl);
      expect(newToken).toMatch(/^[0-9a-f]{64}$/);
      expect(newToken).not.toBe(originalToken);

      const oldMetadata = await request(server()).get(`/invitations/${originalToken}`);
      expect(oldMetadata.status).toBe(404);

      const newMetadata = await request(server()).get(`/invitations/${newToken}`);
      expect(newMetadata.status).toBe(200);
    });

    it("returns invitation link when active workspace is on free plan (CE noop)", async () => {
      const { plaintext } = await createKnownInvitation(
        "free-link@example.com",
        "MEMBER",
        freeWorkspaceId,
      );
      void plaintext;

      const pending = await invitationRepo.findPendingByWorkspace(freeWorkspaceId);
      const invitationId = pending.find((inv) => inv.invitedEmail === "free-link@example.com")?.id;
      expect(invitationId).toBeDefined();

      const freeAuth = await authForWorkspace(freeWorkspaceId);

      const res = await request(server())
        .post(`/workspace/invitations/${invitationId as string}/link`)
        .set("Cookie", `${freeAuth.sessionCookie}; ${freeAuth.csrfCookie}`)
        .set("x-csrf-token", freeAuth.csrfToken);

      expect(res.status).toBe(200);
      const body = res.body as { acceptUrl: string };
      expect(body.acceptUrl).toContain("/invitations/");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /invitations/:token - metadata (public)
  // ---------------------------------------------------------------------------

  describe("GET /invitations/:token - metadata", () => {
    it("returns 404 for an unknown token", async () => {
      const res = await request(server()).get("/invitations/deadbeefdeadbeef");
      expect(res.status).toBe(404);
    });

    it("returns invitation metadata for a valid token", async () => {
      const { plaintext } = await createKnownInvitation("metadata@example.com");
      const res = await request(server()).get(`/invitations/${plaintext}`);

      expect(res.status).toBe(200);
      const body = res.body as {
        workspaceId: string;
        workspaceName: string;
        inviterName: string;
        invitedEmail: string;
        role: string;
        expiresAt: string;
      };
      expect(body.workspaceId).toBe(teamWorkspaceId);
      expect(body.workspaceName).toBe("Team Workspace");
      expect(body.inviterName).toBe("Invite Owner");
      expect(body.invitedEmail).toBe("metadata@example.com");
      expect(body.role).toBe("MEMBER");
    });

    it("returns 410 for an expired invitation", async () => {
      const plaintext = randomBytes(32).toString("hex");
      await invitationRepo.create({
        workspaceId: personalWorkspaceId,
        invitedEmail: "expired@example.com",
        role: "MEMBER",
        tokenHash: hashInvitationToken(plaintext),
        invitedByUserId: ownerUserId,
        expiresAt: new Date(Date.now() - 1000),
      });

      const res = await request(server()).get(`/invitations/${plaintext}`);
      expect(res.status).toBe(410);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /invitations/:token/accept - new user flow (public, @SkipCsrf)
  // ---------------------------------------------------------------------------

  describe("POST /invitations/:token/accept - new user flow", () => {
    it("accepts invitation, creates account, adds member, sets session cookie", async () => {
      const { plaintext } = await createKnownInvitation("newuser-accept@example.com");

      const res = await request(server())
        .post(`/invitations/${plaintext}/accept`)
        .send({ name: "New User", password: "securepassword123!" });

      expect(res.status).toBe(200);
      const body = res.body as { userId: string; workspaceId: string };
      expect(body.workspaceId).toBe(teamWorkspaceId);
      expect(typeof body.userId).toBe("string");

      const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
      const cookies = Array.isArray(setCookie)
        ? setCookie
        : setCookie
          ? [setCookie]
          : [];
      expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);

      const memberWorkspaces = await workspacesService.listUserWorkspaces(body.userId);
      expect(memberWorkspaces.some((ws) => ws.id === teamWorkspaceId)).toBe(true);
    });

    it("returns 409 when invitation was already accepted", async () => {
      const { plaintext } = await createKnownInvitation("accept-twice@example.com");

      await request(server())
        .post(`/invitations/${plaintext}/accept`)
        .send({ name: "Accept Twice", password: "securepassword123!" });

      const res = await request(server())
        .post(`/invitations/${plaintext}/accept`)
        .send({ name: "Accept Twice", password: "securepassword123!" });

      expect(res.status).toBe(409);
    });

    it("returns 410 for an expired invitation", async () => {
      const plaintext = randomBytes(32).toString("hex");
      await invitationRepo.create({
        workspaceId: personalWorkspaceId,
        invitedEmail: "expired-accept@example.com",
        role: "MEMBER",
        tokenHash: hashInvitationToken(plaintext),
        invitedByUserId: ownerUserId,
        expiresAt: new Date(Date.now() - 1000),
      });

      const res = await request(server())
        .post(`/invitations/${plaintext}/accept`)
        .send({ name: "Expired User", password: "securepassword123!" });

      expect(res.status).toBe(410);
    });

    it("returns 422 when name and password are missing for a new account", async () => {
      const { plaintext } = await createKnownInvitation("nopassword@example.com");

      const res = await request(server())
        .post(`/invitations/${plaintext}/accept`)
        .send({});

      expect(res.status).toBe(422);
    });

    it("returns 404 for an unknown token", async () => {
      const res = await request(server())
        .post("/invitations/unknowntoken/accept")
        .send({ name: "X", password: "securepassword123!" });

      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /invitations/:token/accept - existing user flow
  // ---------------------------------------------------------------------------

  describe("POST /invitations/:token/accept - existing user flow", () => {
    it("adds existing user as member and marks accepted", async () => {
      const { plaintext } = await createKnownInvitation("existing-accept@example.com");

      const result = await invitationsService.acceptInvitation(plaintext, {
        name: "Existing User",
        password: "securepassword123!",
      });

      expect(result.userId).toBeTruthy();
      expect(result.workspaceId).toBe(teamWorkspaceId);

      const memberWorkspaces = await workspacesService.listUserWorkspaces(result.userId);
      expect(memberWorkspaces.some((ws) => ws.id === teamWorkspaceId)).toBe(true);
    });
  });
});
