import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness } from "../workspaces/support.ts";
import { codeOf, instanceEvents } from "./support.ts";

// POST /setup stays closed when SETUP_ENABLED=false (doc 02 section 2.2, Q44, doc 10 T3): on an instance with no account at
// all, which is the one state in which the first-run setup would otherwise create an instance admin, the deployment's switch
// decides. The route suite (`routes/setup.integration.test.ts`) walks the rest of the setup; this is the instance-admin
// boundary: no instance admin can be made through it, with or without a setup token, and nothing is written.

const SETUP = "/api/v1/setup";
const BODY = { displayName: "First Admin", email: "first-admin@example.test", password: "a long enough password", workspaceName: "Home" };

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

async function rows(): Promise<{ accounts: number; workspaces: number; admins: number; sessions: number }> {
  const [row] = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ accounts: number; workspaces: number; admins: number; sessions: number }[]>`
      SELECT (SELECT count(*) FROM accounts)::int AS accounts, (SELECT count(*) FROM workspaces)::int AS workspaces,
             (SELECT count(*) FROM accounts WHERE is_instance_admin)::int AS admins, (SELECT count(*) FROM sessions)::int AS sessions`;
  });
  return row ?? { accounts: -1, workspaces: -1, admins: -1, sessions: -1 };
}

describe("POST /setup with SETUP_ENABLED=false", () => {
  it.each([
    ["no setup token required", { SETUP_TOKEN_REQUIRED: "false" }, {}],
    ["a setup token required and none sent", { SETUP_TOKEN_REQUIRED: "true" }, {}],
    ["a setup token required and one sent", { SETUP_TOKEN_REQUIRED: "true" }, { setupToken: "A".repeat(43) }],
  ] as const)("answers 403 setup_completed on an empty instance and creates no account, workspace, session or event, with %s", async (_name, env, extra) => {
    const world = harness.serve({ env: { SETUP_ENABLED: "false", ...env } });
    expect(await rows()).toEqual({ accounts: 0, workspaces: 0, admins: 0, sessions: 0 });

    const response = await send(world, "POST", SETUP, {}, { ...BODY, ...extra });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("setup_completed");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await rows()).toEqual({ accounts: 0, workspaces: 0, admins: 0, sessions: 0 });
    expect(await instanceEvents(database())).toEqual([]);
  });

  it("reports setup as not pending, so the sign-in page offers no first-run form", async () => {
    const world = harness.serve({ env: { SETUP_ENABLED: "false" } });
    const response = await send(world, "GET", `${SETUP}/status`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ setupRequired: false, setupTokenRequired: false });
  });
});
