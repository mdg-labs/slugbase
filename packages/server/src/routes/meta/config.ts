import { getApiConfig } from "@slugbase/contracts";
import type { Adapters } from "@slugbase/core";
import type { BuildInfo } from "../../build-info.ts";
import type { ServerConfig } from "../../config/index.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { route } from "../register.ts";

// GET /api/config (doc 04 section 9.1): what the web app needs before sign-in.
// It is fetched at run time, so one build of the web app runs on any host (doc
// 01 section 11). The document starts with the fields below; the features that
// can populate the others add them.

/** The locales the interface is available in (D19); the first is the default. */
const LOCALES = ["en", "de"] as const;

const CACHE_CONTROL = "public, max-age=60";

export interface ApiConfigOptions {
  readonly config: Pick<ServerConfig, "APP_ORIGIN" | "DOCS_BASE_URL">;
  readonly buildInfo: BuildInfo;
  /** `features` reports whether a port is configured, never an entitlement. */
  readonly adapters: Pick<Adapters, "mail" | "ai">;
}

export function apiConfigRoute({ config, buildInfo, adapters }: ApiConfigOptions): RouteBinding {
  return route(getApiConfig).handle(() => ({
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
    },
  }));
}
