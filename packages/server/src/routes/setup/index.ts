import { sessionCookieSpec, type PasswordPolicy } from "@slugbase/core";
import type { SetupStore } from "@slugbase/db";
import { hashPassword } from "../../auth/password.ts";
import type { ServerConfig } from "../../config/index.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { completeSetupRoute } from "./complete.ts";
import { setupStatusRoute } from "./status.ts";

export { setupRequired } from "./status.ts";

export interface SetupRoutesOptions {
  readonly config: Pick<ServerConfig, "APP_ORIGIN" | "SETUP_ENABLED" | "SETUP_TOKEN_REQUIRED">;
  readonly store: Pick<SetupStore, "setupPending" | "completeSetup">;
  /** Defaults to argon2id hashing. */
  readonly hashPassword?: (password: string) => Promise<string>;
  /** The password policy the first account's password is held to. */
  readonly passwordPolicy: PasswordPolicy;
}

/**
 * What first-run setup contributes (doc 04 section 10.2): whether it is pending, and the
 * single-shot creation of the first account that signs it in.
 */
export function setupRoutes({ config, store, hashPassword: hash = hashPassword, passwordPolicy }: SetupRoutesOptions): RouteBinding[] {
  return [
    setupStatusRoute({ config, store }),
    completeSetupRoute({ config, store, hashPassword: hash, cookie: sessionCookieSpec(config.APP_ORIGIN), passwordPolicy }),
  ];
}
