import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_NAMES, INSTANCE_AUDIT_ACTION_NAMES, INSTANCE_AUDIT_ACTIONS, isInstanceAuditAction } from "../../src/index.ts";

describe("the instance audit catalog", () => {
  it("names the actions of the stream in the dotted style, each with a closed metadata object", () => {
    expect(INSTANCE_AUDIT_ACTION_NAMES).toEqual(["instance.setup_completed", "instance.status_viewed", "instance.settings_viewed", "instance.settings_changed", "instance.test_mail_queued", "instance.workspaces_viewed", "instance.workspace_created", "instance.workspace_deletion_requested"]);
    for (const name of INSTANCE_AUDIT_ACTION_NAMES) {
      expect(name).toMatch(/^instance\.[a-z_]+$/);
    }
    expect(INSTANCE_AUDIT_ACTIONS["instance.settings_viewed"].metadata).toEqual({});
    expect(INSTANCE_AUDIT_ACTIONS["instance.settings_changed"].metadata).toEqual({ settings: "text" });
    expect(INSTANCE_AUDIT_ACTIONS["instance.test_mail_queued"].metadata).toEqual({});
    expect(INSTANCE_AUDIT_ACTIONS["instance.workspaces_viewed"].metadata).toEqual({});
    expect(INSTANCE_AUDIT_ACTIONS["instance.workspace_created"].metadata).toEqual({ owner: "text" });
    expect(INSTANCE_AUDIT_ACTIONS["instance.workspace_deletion_requested"].metadata).toEqual({});
  });

  it("shares no action with the workspace catalog, so a workspace event is never read as an instance one", () => {
    expect(INSTANCE_AUDIT_ACTION_NAMES.filter((name) => (AUDIT_ACTION_NAMES as readonly string[]).includes(name))).toEqual([]);
  });

  it("accepts a name of the catalog and nothing else", () => {
    expect(isInstanceAuditAction("instance.status_viewed")).toBe(true);
    expect(isInstanceAuditAction("workspace.created")).toBe(false);
    expect(isInstanceAuditAction("toString")).toBe(false);
    expect(isInstanceAuditAction(undefined)).toBe(false);
  });
});
