import { INSTANCE_AUDIT_ACTION_NAMES } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { loadOpenApiDocument, classifyOperations } from "@slugbase/testing/tenancy";
import type { MailPort } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount } from "../auth/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness } from "../workspaces/support.ts";
import { clearInstanceEvents, enrolSecondFactor, instanceEvents, signInAdmin } from "./support.ts";

// Every action of the instance admin leaves its event in the instance audit stream (doc 05 section 2.9, doc 02
// section 11, doc 10 T3 and T15). The script below performs one successful request for each /instance operation and
// for each state a request can change an account into, and the check at the end compares the actions it saw with the
// catalog of `@slugbase/core`: an action added to the catalog that no step in the script produces fails the suite by name,
// and so does an /instance operation in openapi.json that the script does not call.

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());
beforeEach(() => clearInstanceEvents(database()));

/**
 * The one catalog action no /instance operation writes: the first-run setup does, and the route suite of the setup asserts
 * it (`setup.integration.test.ts`); the suite here shows that setup left closed writes none.
 */
const WRITTEN_BY_SETUP: readonly string[] = ["instance.setup_completed"];

const document = loadOpenApiDocument();
const INSTANCE_OPERATION_IDS = classifyOperations(document)
  .operations.filter((operation) => operation.path.startsWith("/api/v1/instance"))
  .map((operation) => operation.operationId);

interface Step {
  readonly operationId: string;
  readonly method: string;
  readonly path: () => string;
  readonly body?: unknown;
  readonly status: number;
  /** The actions the request adds to the stream, in order. */
  readonly actions: readonly string[];
  /** The entity the events name, when the step acts on one. */
  readonly entity?: () => string;
}

describe("the instance audit stream", () => {
  it("holds an event of the admin for each /instance operation and each change of an account, and the script covers the whole catalog", async () => {
    const world = harness.serve({ mail });
    const admin = await signInAdmin(database(), world);
    // A second admin keeps the first from being the last when the flag is cleared; the targets differ in what each step needs of them.
    const flagged = await seedAccount(database(), { emailVerified: true });
    const recovered = await seedAccount(database(), { emailVerified: true });
    await enrolSecondFactor(database(), recovered.id);
    const unverified = await seedAccount(database(), { emailVerified: false });
    const deleted = await seedAccount(database(), { emailVerified: true });
    let workspaceId = "";

    const ACCOUNT = "/api/v1/instance/accounts";
    const steps: readonly Step[] = [
      { operationId: "getInstanceStatus", method: "GET", path: () => "/api/v1/instance/status", status: 200, actions: ["instance.status_viewed"] },
      { operationId: "getInstanceSettings", method: "GET", path: () => "/api/v1/instance/settings", status: 200, actions: ["instance.settings_viewed"] },
      { operationId: "updateInstanceSettings", method: "PATCH", path: () => "/api/v1/instance/settings", body: { displayName: "Audit suite" }, status: 200, actions: ["instance.settings_changed"] },
      { operationId: "sendInstanceTestMail", method: "POST", path: () => "/api/v1/instance/mail/test", status: 202, actions: ["instance.test_mail_queued"] },
      { operationId: "listInstanceWorkspaces", method: "GET", path: () => "/api/v1/instance/workspaces", status: 200, actions: ["instance.workspaces_viewed"] },
      { operationId: "createInstanceWorkspace", method: "POST", path: () => "/api/v1/instance/workspaces", body: { name: "Audit suite workspace", ownerEmail: "audit-first-owner@example.test" }, status: 201, actions: ["instance.workspace_created"] },
      { operationId: "issueInstanceWorkspaceOwnerInvitation", method: "POST", path: () => `/api/v1/instance/workspaces/${workspaceId}/owner-invitation`, body: {}, status: 201, actions: ["instance.workspace_owner_invited"], entity: () => workspaceId },
      { operationId: "addInstanceAdminMembership", method: "POST", path: () => `/api/v1/instance/workspaces/${workspaceId}/membership`, status: 201, actions: ["instance.workspace_joined"], entity: () => workspaceId },
      { operationId: "deleteInstanceWorkspace", method: "DELETE", path: () => `/api/v1/instance/workspaces/${workspaceId}`, status: 202, actions: ["instance.workspace_deletion_requested"], entity: () => workspaceId },
      { operationId: "listInstanceAccounts", method: "GET", path: () => ACCOUNT, status: 200, actions: ["instance.accounts_viewed"] },
      { operationId: "updateInstanceAccount", method: "PATCH", path: () => `${ACCOUNT}/${flagged.id}`, body: { isInstanceAdmin: true }, status: 200, actions: ["instance.account_admin_granted"], entity: () => flagged.id },
      { operationId: "updateInstanceAccount", method: "PATCH", path: () => `${ACCOUNT}/${flagged.id}`, body: { isInstanceAdmin: false }, status: 200, actions: ["instance.account_admin_revoked"], entity: () => flagged.id },
      { operationId: "updateInstanceAccount", method: "PATCH", path: () => `${ACCOUNT}/${flagged.id}`, body: { disabled: true }, status: 200, actions: ["instance.account_disabled"], entity: () => flagged.id },
      { operationId: "updateInstanceAccount", method: "PATCH", path: () => `${ACCOUNT}/${flagged.id}`, body: { disabled: false }, status: 200, actions: ["instance.account_enabled"], entity: () => flagged.id },
      { operationId: "resetInstanceAccountMfa", method: "POST", path: () => `${ACCOUNT}/${recovered.id}/mfa-reset`, status: 204, actions: ["instance.account_mfa_reset"], entity: () => recovered.id },
      { operationId: "issueInstanceAccountResetLink", method: "POST", path: () => `${ACCOUNT}/${recovered.id}/password-reset-link`, status: 200, actions: ["instance.account_reset_link_issued"], entity: () => recovered.id },
      { operationId: "resendInstanceAccountVerification", method: "POST", path: () => `${ACCOUNT}/${unverified.id}/verification-email`, status: 202, actions: ["instance.account_verification_resent"], entity: () => unverified.id },
      { operationId: "updateInstanceAccount", method: "PATCH", path: () => `${ACCOUNT}/${unverified.id}`, body: { emailVerified: true }, status: 200, actions: ["instance.account_email_verified"], entity: () => unverified.id },
      { operationId: "deleteInstanceAccount", method: "DELETE", path: () => `${ACCOUNT}/${deleted.id}`, status: 204, actions: ["instance.account_deleted"], entity: () => deleted.id },
    ];

    expect([...new Set(steps.map((step) => step.operationId))].sort(), "the script must call every /instance operation of openapi.json").toEqual([...INSTANCE_OPERATION_IDS].sort());

    const seen = new Set<string>();
    for (const step of steps) {
      const before = (await instanceEvents(database())).length;
      const response = await send(world, step.method, step.path(), { cookie: admin.cookie }, step.body);
      const label = `${step.operationId} ${JSON.stringify(step.body ?? {})}`;
      expect(response.status, label).toBe(step.status);
      if (step.operationId === "createInstanceWorkspace") {
        workspaceId = ((await response.json()) as { id: string }).id;
      }
      const written = (await instanceEvents(database())).slice(before);
      expect(
        written.map((event) => event.action),
        label,
      ).toEqual(step.actions);
      for (const event of written) {
        expect(event.actor_account_id, label).toBe(admin.accountId);
        if (step.entity !== undefined) {
          expect(event.entity_id, label).toBe(step.entity());
        }
        seen.add(event.action);
      }
    }

    const missing = INSTANCE_AUDIT_ACTION_NAMES.filter((action) => !seen.has(action) && !WRITTEN_BY_SETUP.includes(action));
    expect(missing, "catalog actions no step of the script writes").toEqual([]);
    expect([...seen].filter((action) => !(INSTANCE_AUDIT_ACTION_NAMES as readonly string[]).includes(action))).toEqual([]);
  }, HOOK_TIMEOUT_MS);
});
