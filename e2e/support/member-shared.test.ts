import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { STORAGE_STATE } from "./environment.ts";
import { MAIL_WAIT_MS } from "./mailpit.ts";
import {
  clearSharedMembers,
  PROVISION_MS,
  READY_TIMEOUT_MS,
  SHARED_MEMBER_HOOK_TIMEOUT_MS,
  SHARED_MEMBERS_DIR,
  sharedMemberState,
} from "./member-shared.ts";

// The default timeout of a hook, `timeout` of playwright.config.ts.
const DEFAULT_TIMEOUT_MS = 30_000;

void describe("the timeout of a hook that provisions a shared member", () => {
  void it("outlasts the wait of the journeys that wait for the session", () => {
    assert.ok(SHARED_MEMBER_HOOK_TIMEOUT_MS > READY_TIMEOUT_MS);
  });

  void it("outlasts the wait for the invitation mail and the requests around it", () => {
    assert.ok(PROVISION_MS > MAIL_WAIT_MS);
    assert.ok(SHARED_MEMBER_HOOK_TIMEOUT_MS > PROVISION_MS);
  });

  void it("is longer than the default timeout the hook would otherwise have", () => {
    assert.ok(SHARED_MEMBER_HOOK_TIMEOUT_MS > DEFAULT_TIMEOUT_MS);
  });
});

void describe("the state of the shared members", () => {
  void it("is kept in a directory of its own beside the session of the setup project, not in the directory of that session", () => {
    assert.equal(dirname(SHARED_MEMBERS_DIR), dirname(STORAGE_STATE));
    assert.notEqual(SHARED_MEMBERS_DIR, dirname(STORAGE_STATE));
    assert.equal(dirname(sharedMemberState("palette")), SHARED_MEMBERS_DIR);
  });

  void it("is gone after the clear, with the claim and the markers beside the session, and the directory is left to be made again", () => {
    const root = mkdtempSync(join(tmpdir(), "slugbase-members-"));
    try {
      const dir = join(root, "members");
      const state = sharedMemberState("palette", dir);
      assert.equal(dirname(state), dir);
      mkdirSync(`${state}.claim`, { recursive: true });
      writeFileSync(state, "{}");
      writeFileSync(`${state}.ready`, "");
      writeFileSync(`${state}.failed`, "");
      writeFileSync(join(root, "state.json"), "{}");
      clearSharedMembers(dir);
      assert.equal(existsSync(dir), false);
      assert.equal(existsSync(join(root, "state.json")), true);
      clearSharedMembers(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
