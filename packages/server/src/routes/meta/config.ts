import { getApiConfig } from "@slugbase/contracts";
import { registrationUnavailable, type Adapters, type IdentityPort, type RegistrationSettings } from "@slugbase/core";
import type { InstanceSettingsStore, SetupStore } from "@slugbase/db";
import type { BuildInfo } from "../../build-info.ts";
import type { ServerConfig } from "../../config/index.ts";
import type { Logger } from "../../create-server.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { route } from "../register.ts";
import { setupStatus } from "../setup/status.ts";

// GET /api/config (doc 04 section 9.1): what the web app needs before sign-in.
// It is fetched at run time, so one build of the web app runs on any host (doc
// 01 section 11). The document starts with the fields below; the features that
// can populate the others add them. `instance` carries the display name and the sign-in notice the instance admin
// stored (doc 02 section 11.3): the notice is plain text and the sign-in page renders it as text only. They are
// read for every request, and the answer is cached for a minute like the rest of the document.

/** The locales the interface is available in (D19); the first is the default. */
const LOCALES = ["en", "de"] as const;

const CACHE_CONTROL = "public, max-age=60";

export interface ApiConfigOptions {
  readonly config: Pick<ServerConfig, "APP_ORIGIN" | "DOCS_BASE_URL" | "SETUP_ENABLED" | "SETUP_TOKEN_REQUIRED">;
  /** `setupRequired` and `setupTokenRequired` are the answer of `GET /api/v1/setup/status`. */
  readonly store: Pick<SetupStore, "setupPending"> & InstanceSettingsStore;
  readonly buildInfo: BuildInfo;
  /** `features` reports whether a port is configured, never an entitlement. */
  readonly adapters: Pick<Adapters, "mail" | "ai" | "identity">;
  /** The settings in force for public registration: `signIn.registration` is whether they let a registration through now. */
  readonly registration: RegistrationSettings;
  readonly logger: Pick<Logger, "warn">;
}

// The providers the operator enabled that are available now, as the sign-in page needs them. Nothing of a
// provider but its slug and name is read, so no secret or URL can reach the answer. A port that cannot
// list them leaves the list empty and the rest of the document intact (D22).
async function oidcProviders(identity: IdentityPort, logger: Pick<Logger, "warn">): Promise<{ slug: string; name: string }[]> {
  if (!identity.available) {
    return [];
  }
  try {
    return (await identity.listProviders()).map(({ id, displayName }) => ({ slug: id, name: displayName }));
  } catch (error) {
    logger.warn("The OIDC providers could not be listed", { error: error instanceof Error ? error.name : typeof error });
    return [];
  }
}

export function apiConfigRoute({ config, store, buildInfo, adapters, registration, logger }: ApiConfigOptions): RouteBinding {
  return route(getApiConfig).handle(async () => {
    const { displayName, signInNotice } = await store.instanceSettings();
    return {
      status: 200,
      headers: { "Cache-Control": CACHE_CONTROL },
      body: {
        apiVersion: "v1",
        origin: config.APP_ORIGIN,
        product: { name: buildInfo.name, version: buildInfo.version },
        locales: [...LOCALES],
        defaultLocale: LOCALES[0],
        docsBaseUrl: config.DOCS_BASE_URL,
        features: { mail: adapters.mail.available, ai: adapters.ai.available },
        signIn: {
          registration: registrationUnavailable(registration, adapters.mail.available) === undefined,
          oidc: await oidcProviders(adapters.identity, logger),
        },
        instance: { displayName: displayName ?? buildInfo.name, signInNotice },
        ...(await setupStatus({ config, store })),
      },
    };
  });
}
