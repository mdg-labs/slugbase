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

  it("names every notification by the template of the same name", () => {
    for (const notification of ACCOUNT_NOTIFICATIONS) {
      expect(accountNotification(notification, { email: "a@example.test", locale: "en", displayName: "A" }).template).toBe(notification);
    }
  });
});
