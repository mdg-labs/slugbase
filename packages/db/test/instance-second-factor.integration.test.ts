import { InstanceAdminRequiredError } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceRepository, type QueuedJob } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";

// Which sys_instance_* functions need a second factor enrolled on the account of the transaction (Q45, doc 05
// section 3.3). The failure scenario: an instance admin who has no second factor reaches every function of the
// instance admin directly. The five of the instanceAdminWithoutSecondFactor policy answer; each of the other eleven
// raises insufficient_privilege. The five still refuse an account that is not an admin and a disabled admin.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

interface Options {
  readonly admin?: boolean;
  readonly mfa?: boolean;
  readonly disabled?: boolean;
}

async function account(options: Options = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, {
    id,
    email: `second-factor${String(emailNumber)}@example.test`,
    passwordHash: "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    disabledAt: options.disabled === true ? new Date() : null,
  });
  if (options.mfa === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${id}`;
    });
  }
  return id;
}

type Call = (tx: postgres.TransactionSql) => Promise<unknown>;
type Repository = ReturnType<typeof instanceRepository>;

/** One call of each function of the instance admin, with arguments that pass the argument checks, keyed by the function. */
function calls(target: string): Record<string, Call> {
  const unknown = freshId();
  return {
    sys_instance_status: (tx) => tx`SELECT * FROM sys_instance_status(${freshId()}::uuid, NULL::cidr)`,
    sys_instance_settings: (tx) => tx`SELECT * FROM sys_instance_settings(${freshId()}::uuid, NULL::cidr)`,
    sys_instance_test_mail: (tx) => tx`SELECT sys_instance_test_mail(${freshId()}::uuid, NULL::cidr)`,
    sys_instance_list_workspaces: (tx) => tx`SELECT * FROM sys_instance_list_workspaces(${freshId()}::uuid, NULL::cidr)`,
    sys_instance_create_workspace: (tx) =>
      tx`SELECT * FROM sys_instance_create_workspace(${freshId()}::uuid, NULL::cidr, ${freshId()}::uuid, 'Created without a second factor', ${target}::uuid, NULL::citext, NULL::uuid, NULL::bytea, NULL::integer)`,
    sys_instance_update_settings: (tx) =>
      tx`SELECT * FROM sys_instance_update_settings(${freshId()}::uuid, NULL::cidr, false, NULL::boolean, true, 'Name', false, NULL::text)`,
    sys_instance_add_membership: (tx) => tx`SELECT sys_instance_add_membership(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${unknown}::uuid)`,
    sys_instance_reissue_owner_invitation: (tx) =>
      tx`SELECT * FROM sys_instance_reissue_owner_invitation(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid, 'owner@example.test'::citext, ${freshId()}::uuid, ${freshToken().hash}, 3600)`,
    sys_instance_delete_workspace: (tx) => tx`SELECT sys_instance_delete_workspace(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid)`,
    sys_instance_list_accounts: (tx) => tx`SELECT * FROM sys_instance_list_accounts(${freshId()}::uuid, NULL::cidr)`,
    sys_instance_update_account: (tx) =>
      tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${unknown}::uuid, false, false)`,
    sys_instance_set_account_access_mode: (tx) =>
      tx`SELECT sys_instance_set_account_access_mode(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid, 'full', NULL::timestamptz, NULL::text)`,
    sys_instance_reset_mfa: (tx) => tx`SELECT sys_instance_reset_mfa(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid)`,
    sys_instance_issue_reset_link: (tx) =>
      tx`SELECT sys_instance_issue_reset_link(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid, ${freshId()}::uuid, ${freshToken().hash})`,
    sys_instance_resend_verification: (tx) => tx`SELECT sys_instance_resend_verification(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid)`,
    sys_instance_delete_account: (tx) => tx`SELECT sys_instance_delete_account(${freshId()}::uuid, NULL::cidr, ${unknown}::uuid, ARRAY[]::uuid[])`,
  };
}

/** The functions whose operations declare the instanceAdminWithoutSecondFactor policy. */
const WITHOUT_SECOND_FACTOR = [
  "sys_instance_status",
  "sys_instance_settings",
  "sys_instance_test_mail",
  "sys_instance_list_workspaces",
  "sys_instance_create_workspace",
] as const;

async function codeOf(accountId: string, call: Call): Promise<string | undefined> {
  try {
    await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', '', true)`;
      await call(tx);
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

describe("the second factor of the sys_instance_* functions", () => {
  it("lists sixteen functions, five of them without the second factor", () => {
    expect(Object.keys(calls(freshId()))).toHaveLength(16);
    expect(WITHOUT_SECOND_FACTOR).toHaveLength(5);
  });

  it("answers an admin without a second factor in exactly the five functions and raises insufficient_privilege in the other eleven", async () => {
    const admin = await account({ admin: true });
    const target = await account();
    const results = new Map<string, string | undefined>();
    for (const [name, call] of Object.entries(calls(target))) {
      results.set(name, await codeOf(admin, call));
    }

    expect([...results].filter(([, code]) => code === undefined).map(([name]) => name).toSorted()).toEqual([...WITHOUT_SECOND_FACTOR].toSorted());
    expect([...results].filter(([, code]) => code !== undefined).map(([, code]) => code)).toEqual(Array<string>(11).fill(INSUFFICIENT_PRIVILEGE));
  });

  it("does not raise insufficient_privilege in any of the sixteen for an admin with a second factor, so the eleven refusals are the second factor's", async () => {
    const admin = await account({ admin: true, mfa: true });
    const target = await account();
    for (const [name, call] of Object.entries(calls(target))) {
      expect(await codeOf(admin, call), name).not.toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an account with neither the flag nor a second factor", {}],
    ["a disabled admin without a second factor", { admin: true, disabled: true }],
    ["a disabled admin with a second factor", { admin: true, mfa: true, disabled: true }],
  ] satisfies [string, Options][])("raises insufficient_privilege for %s in all sixteen", async (_name, options) => {
    const caller = await account(options);
    const target = await account();
    for (const [name, call] of Object.entries(calls(target))) {
      expect(await codeOf(caller, call), name).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("raises insufficient_privilege in the five when no account is set for the transaction", async () => {
    const target = await account();
    for (const name of WITHOUT_SECOND_FACTOR) {
      const call = calls(target)[name];
      expect(call, name).toBeDefined();
      let code: string | undefined;
      try {
        await db.app.begin(async (tx) => {
          await call?.(tx);
        });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code, name).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe("the repository's answer to a refusal of the five functions", () => {
  it("throws InstanceAdminRequiredError from each of the five for an account that is not an admin, as it does for the other eleven", async () => {
    const caller = await account({ mfa: true });
    const target = await account();
    const mail: QueuedJob = { id: freshId(), queue: "mail.send", data: { template: "testMail", accountId: caller } };
    const requests: Record<string, (repository: Repository) => Promise<unknown>> = {
      status: (repository) => repository.status(freshId(), null),
      viewSettings: (repository) => repository.viewSettings(freshId(), null),
      recordTestMail: (repository) => repository.recordTestMail(freshId(), null, mail),
      listWorkspaces: (repository) => repository.listWorkspaces(freshId(), null),
      createWorkspace: (repository) =>
        repository.createWorkspace({ workspaceId: freshId(), name: "Refused", owner: { kind: "account", accountId: target }, events: [] }, freshId(), null, []),
    };
    for (const [name, request] of Object.entries(requests)) {
      const refusal = await db.tenant.withTenant({ accountId: caller, requestId: "req-second-factor" }, (tx) => request(instanceRepository(tx))).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal, name).toBeInstanceOf(InstanceAdminRequiredError);
    }
  });

  it("throws it from updateSettings for an admin without a second factor, and from none of the five for the same admin", async () => {
    const admin = await account({ admin: true });
    const asAdmin = (work: (repository: Repository) => Promise<unknown>): Promise<unknown> =>
      db.tenant.withTenant({ accountId: admin, requestId: "req-second-factor" }, (tx) => work(instanceRepository(tx)));

    const refusal = await asAdmin((repository) => repository.updateSettings({ displayName: "Refused" }, freshId(), null)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(InstanceAdminRequiredError);
    await expect(asAdmin((repository) => repository.status(freshId(), null))).resolves.toBeDefined();
    await expect(asAdmin((repository) => repository.viewSettings(freshId(), null))).resolves.toBeDefined();
    await expect(asAdmin((repository) => repository.listWorkspaces(freshId(), null))).resolves.toBeDefined();
  });
});
