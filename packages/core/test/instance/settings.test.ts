import { describe, expect, it } from "vitest";
import { INSTANCE_SETTING_NAMES, INSTANCE_TEST_MAIL_TEMPLATE, UNSET_INSTANCE_SETTINGS, instanceTestMail, workspaceCreationAllowed } from "../../src/index.ts";

describe("workspaceCreationAllowed", () => {
  it("uses the default of the composition while the setting is not set", () => {
    expect(workspaceCreationAllowed(UNSET_INSTANCE_SETTINGS, false)).toBe(false);
    expect(workspaceCreationAllowed(UNSET_INSTANCE_SETTINGS, true)).toBe(true);
  });

  it("lets a stored setting override the default in both directions", () => {
    expect(workspaceCreationAllowed({ allowWorkspaceCreation: false }, true)).toBe(false);
    expect(workspaceCreationAllowed({ allowWorkspaceCreation: true }, false)).toBe(true);
  });
});

describe("the instance settings", () => {
  it("are three, named as the API and the audit event name them, and none is set by default", () => {
    expect(INSTANCE_SETTING_NAMES).toEqual(["allowWorkspaceCreation", "displayName", "signInNotice"]);
    expect(UNSET_INSTANCE_SETTINGS).toEqual({ allowWorkspaceCreation: null, displayName: null, signInNotice: null });
  });
});

describe("instanceTestMail", () => {
  it("addresses the test template to the account's address in its language, with its name as the only data", () => {
    expect(instanceTestMail({ email: "ada@example.test", locale: "de", displayName: "Ada" })).toEqual({
      template: "testMail",
      to: "ada@example.test",
      locale: "de",
      data: { displayName: "Ada" },
    });
    expect(INSTANCE_TEST_MAIL_TEMPLATE).toBe("testMail");
  });
});
