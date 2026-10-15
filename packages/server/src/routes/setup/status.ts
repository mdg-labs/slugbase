import { getSetupStatus } from "@slugbase/contracts";
import type { SetupStore } from "@slugbase/db";
import type { ServerConfig } from "../../config/index.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { route } from "../register.ts";

// GET /api/v1/setup/status (doc 04 section 10.2) and the `setupRequired` and
// `setupTokenRequired` of GET /api/config (section 9.1) are one answer: the
// deployment has setup turned on and the instance still waits for its first
// account, and whether that account needs the setup token.

export interface SetupStatusOptions {
  readonly config: Pick<ServerConfig, "SETUP_ENABLED" | "SETUP_TOKEN_REQUIRED">;
  readonly store: Pick<SetupStore, "setupPending">;
}

/**
 * Whether first-run setup is pending. A deployment with setup turned off never asks the database.
 * A database that cannot answer rejects: it is neither "pending" nor "done".
 */
export async function setupRequired({ config, store }: SetupStatusOptions): Promise<boolean> {
  return config.SETUP_ENABLED && (await store.setupPending());
}

/** The one answer both endpoints give; the token requirement only means something while setup is pending. */
export async function setupStatus(options: SetupStatusOptions): Promise<{ setupRequired: boolean; setupTokenRequired: boolean }> {
  const pending = await setupRequired(options);
  return { setupRequired: pending, setupTokenRequired: pending && options.config.SETUP_TOKEN_REQUIRED };
}

export function setupStatusRoute(options: SetupStatusOptions): RouteBinding {
  return route(getSetupStatus).handle(async () => ({ status: 200, body: await setupStatus(options) }));
}
