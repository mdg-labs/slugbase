import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MailService } from "@slugbase/shared-types";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import {
  ChallengeVerificationError,
  type ChallengeService,
} from "../src/challenge/challenge.interface.js";
import { CHALLENGE } from "../src/challenge/challenge.tokens.js";
import { MAIL } from "../src/mail/mail.tokens.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

const validPayload = {
  name: "Alex Kerr",
  email: "alex@example.com",
  topic: "support",
  message: "Need help with my workspace.",
  challengeToken: "valid-turnstile-token",
};

describe("Contact endpoint (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let challengeVerify: ReturnType<typeof vi.fn>;
  let mailSend: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    challengeVerify = vi.fn();
    mailSend = vi.fn().mockResolvedValue(undefined);

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      SMTP_FROM: "support@slugbase.test",
    });

    const challenge: ChallengeService = {
      isAvailable: () => true,
      isDevSkipEnabled: () => false,
      verify: challengeVerify,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CHALLENGE)
      .useValue(challenge)
      .overrideProvider(MAIL)
      .useValue({
        isAvailable: () => true,
        send: mailSend,
        sendTest: vi.fn().mockResolvedValue(undefined),
      } satisfies MailService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
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

  it("rejects bad challenge tokens", async () => {
    challengeVerify.mockRejectedValueOnce(new ChallengeVerificationError());

    const response = await request(server()).post("/contact").send(validPayload);

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ message: "Challenge verification failed" }),
    );
    expect(mailSend).not.toHaveBeenCalled();
  });

  it("sends mail on valid challenge", async () => {
    challengeVerify.mockResolvedValueOnce(undefined);

    const response = await request(server()).post("/contact").send(validPayload);

    expect(response.status).toBe(204);
    expect(mailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "support@slugbase.test",
        type: "contact_form_notification",
        subject: "[SlugBase Contact] Support",
      }),
    );
  });
});
