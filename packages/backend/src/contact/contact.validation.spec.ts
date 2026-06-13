import { describe, expect, it } from "vitest";

import {
  CONTACT_MESSAGE_MAX_LENGTH,
  CONTACT_NAME_MAX_LENGTH,
} from "./contact.constants.js";
import {
  parseContactSubmitBody,
  sanitizeContactField,
} from "./contact.validation.js";

describe("contact.validation", () => {
  it("accepts a valid contact payload", () => {
    const body = parseContactSubmitBody({
      name: "Alex Kerr",
      email: "alex@example.com",
      topic: "support",
      message: "Need help.",
      challengeToken: "token",
    });

    expect(body.email).toBe("alex@example.com");
    expect(body.topic).toBe("support");
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseContactSubmitBody({
        name: "Alex Kerr",
        email: "alex@example.com",
        topic: "support",
        message: "Need help.",
        challengeToken: "token",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects empty message", () => {
    expect(() =>
      parseContactSubmitBody({
        name: "Alex Kerr",
        email: "alex@example.com",
        topic: "support",
        message: "   ",
        challengeToken: "token",
      }),
    ).toThrow();
  });

  it("enforces max lengths", () => {
    expect(() =>
      parseContactSubmitBody({
        name: "a".repeat(CONTACT_NAME_MAX_LENGTH + 1),
        email: "alex@example.com",
        topic: "support",
        message: "Need help.",
        challengeToken: "token",
      }),
    ).toThrow();

    expect(() =>
      parseContactSubmitBody({
        name: "Alex Kerr",
        email: "alex@example.com",
        topic: "support",
        message: "a".repeat(CONTACT_MESSAGE_MAX_LENGTH + 1),
        challengeToken: "token",
      }),
    ).toThrow();
  });

  it("sanitizes HTML-like content", () => {
    expect(sanitizeContactField("<script>x</script>Hello")).toBe("x/scriptHello");
    expect(sanitizeContactField("Hello <b>world</b>")).toBe("Hello bworld/b");
  });
});
