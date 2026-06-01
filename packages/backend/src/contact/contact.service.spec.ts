import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  ChallengeVerificationError,
  type ChallengeService,
} from "../challenge/challenge.interface.js";
import type { ConfigService } from "../config/config.service.js";
import type { MailService } from "@slugbase/shared-types";
import { ContactService } from "./contact.service.js";

function createChallenge(overrides: Partial<ChallengeService> = {}): ChallengeService {
  return {
    isAvailable: () => true,
    isDevSkipEnabled: () => false,
    verify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMail(overrides: Partial<MailService> = {}): MailService {
  return {
    isAvailable: () => true,
    send: vi.fn().mockResolvedValue(undefined),
    sendTest: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createConfig(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

const validBody = {
  name: "Alex Kerr",
  email: "alex@example.com",
  topic: "support",
  message: "Need help with my workspace.",
  challengeToken: "turnstile-token",
};

describe("ContactService", () => {
  it("sends a contact notification when challenge and mail are available", async () => {
    const mail = createMail();
    const service = new ContactService(
      createChallenge(),
      mail,
      createConfig({ SMTP_FROM: "support@slugbase.test" }),
    );

    await service.submit(validBody, "203.0.113.1");

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "support@slugbase.test",
        type: "contact_form_notification",
        subject: "[SlugBase Contact] Support",
        text: expect.stringContaining("alex@example.com"),
      }),
    );
  });

  it("rejects invalid request bodies", async () => {
    const service = new ContactService(
      createChallenge(),
      createMail(),
      createConfig({ SMTP_FROM: "support@slugbase.test" }),
    );

    await expect(service.submit({ ...validBody, email: "not-an-email" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects failed challenge verification", async () => {
    const challenge = createChallenge({
      verify: vi.fn().mockRejectedValue(new ChallengeVerificationError()),
    });
    const mail = createMail();
    const service = new ContactService(
      challenge,
      mail,
      createConfig({ SMTP_FROM: "support@slugbase.test" }),
    );

    await expect(service.submit(validBody)).rejects.toBeInstanceOf(BadRequestException);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("rejects when mail transport is unavailable", async () => {
    const service = new ContactService(
      createChallenge(),
      createMail({ isAvailable: () => false }),
      createConfig({ SMTP_FROM: "support@slugbase.test" }),
    );

    await expect(service.submit(validBody)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("rejects when no notification recipient is configured", async () => {
    const service = new ContactService(
      createChallenge(),
      createMail(),
      createConfig({ SMTP_FROM: undefined }),
    );

    await expect(service.submit(validBody)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("strips HTML from free-text fields before sending", async () => {
    const mail = createMail();
    const service = new ContactService(
      createChallenge(),
      mail,
      createConfig({ SMTP_FROM: "support@slugbase.test" }),
    );

    await service.submit({
      ...validBody,
      name: "<script>alert(1)</script>Pat",
      message: "Hello <b>world</b>",
    });

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Pat"),
      }),
    );
    const sendArg = vi.mocked(mail.send).mock.calls[0]?.[0];
    expect(sendArg?.text).not.toContain("<");
    expect(sendArg?.text).not.toContain(">");
  });
});
