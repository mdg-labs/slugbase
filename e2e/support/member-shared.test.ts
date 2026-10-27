import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAIL_WAIT_MS } from "./mailpit.ts";
import { PROVISION_MS, READY_TIMEOUT_MS, SHARED_MEMBER_HOOK_TIMEOUT_MS } from "./member-shared.ts";

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
