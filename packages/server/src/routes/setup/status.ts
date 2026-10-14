import { getSetupStatus } from "@slugbase/contracts";
import type { SetupStore } from "@slugbase/db";
import type { ServerConfig } from "../../config/index.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { route } from "../register.ts";

// GET /api/v1/setup/status (doc 04 section 10.2) and the `setupRequired` of
// GET /api/config (section 9.1) are one answer: the deployment has setup turned
// on and the instance still waits for its first account.

export interface SetupStatusOptions {
  readonly config: Pick<ServerConfig, "SETUP_ENABLED">;
  readonly store: Pick<SetupStore, "setupPending">;
}

/**
 * Whether first-run setup is pending. A deployment with setup turned off never asks the database.
 * A database that cannot answer rejects: it is neither "pending" nor "done".
 */
export async function setupRequired({ config, store }: SetupStatusOptions): Promise<boolean> {
  return config.SETUP_ENABLED && (await store.setupPending());
}

export function setupStatusRoute(options: SetupStatusOptions): RouteBinding {
  return route(getSetupStatus).handle(async () => ({ status: 200, body: { setupRequired: await setupRequired(options) } }));
}
