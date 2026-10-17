import { describe, expect, it } from "vitest";
import { ACCOUNT_NOTIFICATIONS, accountNotification } from "../../src/auth/notifications.ts";

describe("accountNotification", () => {
  it("addresses the message to the account's address, in the account's language, with its name as the only data", () => {
    expect(accountNotification("passwordChanged", { email: "ada@example.test", locale: "de", displayName: "Ada" })).toEqual({
      template: "passwordChanged",
      to: "ada@example.test",
      locale: "de",
      data: { displayName: "Ada" },
    });
  });

  it("carries the data a template needs beside the name, and the name cannot be overridden by it", () => {
    expect(
      accountNotification("verifyEmail", { email: "ada@example.test", locale: "en", displayName: "Ada" }, { token: "abc", displayName: "Mallory" }),
    ).toEqual({ template: "verifyEmail", to: "ada@example.test", locale: "en", data: { token: "abc", displayName: "Ada" } });
  });

  it("names the password, the second-factor, the verification and the new sign-in notifications", () => {
    expect(ACCOUNT_NOTIFICATIONS).toEqual(["passwordChanged", "mfaEnabled", "mfaDisabled", "verifyEmail", "newSignIn"]);
  });

  it("names every notification by the template of the same name", () => {
    for (const notification of ACCOUNT_NOTIFICATIONS) {
      expect(accountNotification(notification, { email: "a@example.test", locale: "en", displayName: "A" }).template).toBe(notification);
    }
  });
});
