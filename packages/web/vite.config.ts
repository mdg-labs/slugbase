import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import {
  sentryReactRouter,
  type SentryReactRouterBuildOptions,
} from "@sentry/react-router";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

import { applyViteEditionEnv } from "./app/lib/vite-edition-env.js";

applyViteEditionEnv();

const sentryAuthToken = process.env["SENTRY_AUTH_TOKEN"];
const sentryOrg = process.env["SENTRY_ORG"];
const sentryProject = process.env["SENTRY_PROJECT"];

/**
 * Derives the Sentry release string from CI env or root package.json.
 * Matches the backend auto-derivation: `slugbase@<version>`.
 */
function deriveSentryRelease(): string | undefined {
  const envRelease = process.env["VITE_SENTRY_RELEASE"];
  if (envRelease) {
    return envRelease;
  }
  try {
    const rootPkg = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(rootPkg, "utf-8")) as {
      version?: string;
    };
    return pkg.version !== undefined
      ? `slugbase@${pkg.version}`
      : undefined;
  } catch {
    return undefined;
  }
}

const sentryRelease = deriveSentryRelease();
const sentryEnvironment = process.env["VITE_SENTRY_ENVIRONMENT"];

const sentryConfig: SentryReactRouterBuildOptions = {
  org: sentryOrg ?? "",
  project: sentryProject ?? "",
  authToken: sentryAuthToken,
  ...(sentryRelease ? { release: { name: sentryRelease } } : {}),
  ...(sentryEnvironment
    ? { release: { deploy: { env: sentryEnvironment } } }
    : {}),
  telemetry: false,
};

export default defineConfig((config) => ({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
    sentryReactRouter(sentryConfig, config),
  ],
  build: {
    sourcemap: Boolean(sentryAuthToken),
  },
}));