import { getApiConfig, LegalLinksSchema } from "@slugbase/contracts";
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
// can populate the others add them: `features.billing` is whether the billing port is configured, and `legal` is
// what the composition supplied (`LegalLinks`), absent when it supplied none. `instance` carries the display name and the sign-in notice the instance admin
// stored (doc 02 section 11.3): the notice is plain text and the sign-in page renders it as text only. They are
// read for every request, and the answer is cached for a minute like the rest of the document.

/** The locales the interface is available in (D19); the first is the default. */
const LOCALES = ["en", "de"] as const;

const CACHE_CONTROL = "public, max-age=60";

/** The addresses of a deployment's legal documents, which the composition root supplies and `GET /api/config` publishes. */
export interface LegalLinks {
  /** The address of the imprint. */
  readonly imprintUrl: string;
  /** The address of the privacy policy. */
  readonly privacyUrl: string;
  /** The address of the terms of service. */
  readonly termsUrl: string;
}

// A control character or a space anywhere in an address is refused: `URL` drops tabs and line breaks inside one, so the
// text served would differ from the address a client reads. Userinfo is refused because the answer is public.
const UNSAFE_URL_TEXT = /[\u0000-\u0020\u007f]/;

/**
 * What is wrong with the legal links, naming the member and never repeating its value (an address may carry userinfo),
 * or `undefined` when all three are plain absolute `https` or `http` addresses.
 */
export function legalLinksProblem(legal: unknown): string | undefined {
  if (typeof legal !== "object" || legal === null || Array.isArray(legal)) {
    return "legal must be an object with imprintUrl, privacyUrl and termsUrl";
  }
  const record = legal as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in LegalLinksSchema.shape)) {
      return `legal has an unknown member ${JSON.stringify(key)}; it holds imprintUrl, privacyUrl and termsUrl only`;
    }
  }
  for (const key of Object.keys(LegalLinksSchema.shape)) {
    const value = record[key];
    if (typeof value !== "string" || !LegalLinksSchema.shape[key as keyof LegalLinks].safeParse(value).success) {
      return `legal.${key} must be an absolute https or http address`;
    }
    if (UNSAFE_URL_TEXT.test(value)) {
      return `legal.${key} must not contain a space or a control character`;
    }
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") {
      return `legal.${key} must not carry a user name or a password`;
    }
  }
  return undefined;
}

export interface ApiConfigOptions {
  readonly config: Pick<ServerConfig, "AI_PROVIDER_NAME" | "APP_ORIGIN" | "DOCS_BASE_URL" | "SETUP_ENABLED" | "SETUP_TOKEN_REQUIRED">;
  /** `setupRequired` and `setupTokenRequired` are the answer of `GET /api/v1/setup/status`. */
  readonly store: Pick<SetupStore, "setupPending"> & InstanceSettingsStore;
  readonly buildInfo: BuildInfo;
  /** `features` reports whether a port is configured, never an entitlement. */
  readonly adapters: Pick<Adapters, "mail" | "ai" | "identity" | "billing">;
  /** The settings in force for public registration: `signIn.registration` is whether they let a registration through now. */
  readonly registration: RegistrationSettings;
  readonly logger: Pick<Logger, "warn">;
  /** Already checked by `legalLinksProblem`; the answer carries `legal` only when it is given. */
  readonly legal?: LegalLinks;
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

export function apiConfigRoute({ config, store, buildInfo, adapters, registration, logger, legal }: ApiConfigOptions): RouteBinding {
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
        features: {
          mail: adapters.mail.available,
          ai: adapters.ai.available,
          billing: adapters.billing.available,
          // The name members see (D22); the endpoint, the model and the key never leave the server.
          ...(adapters.ai.available && config.AI_PROVIDER_NAME !== undefined ? { aiProvider: config.AI_PROVIDER_NAME } : {}),
        },
        signIn: {
          registration: registrationUnavailable(registration, adapters.mail.available) === undefined,
          oidc: await oidcProviders(adapters.identity, logger),
        },
        ...(legal === undefined ? {} : { legal: { imprintUrl: legal.imprintUrl, privacyUrl: legal.privacyUrl, termsUrl: legal.termsUrl } }),
        instance: { displayName: displayName ?? buildInfo.name, signInNotice },
        ...(await setupStatus({ config, store })),
      },
    };
  });
}
