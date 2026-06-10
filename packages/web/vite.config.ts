import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type PluginOption } from "vite";

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
    const pkg = JSON.parse(readFileSync(rootPkg, "utf-8")) as { version?: string };
    return pkg.version !== undefined
      ? `slugbase@${pkg.version}`
      : undefined;
  } catch {
    return undefined;
  }
}

const sentryRelease = deriveSentryRelease();
const sentryEnvironment = process.env["VITE_SENTRY_ENVIRONMENT"];

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
    ...(sentryAuthToken
      ? [
          sentryVitePlugin({
            authToken: sentryAuthToken,
            org: sentryOrg,
            project: sentryProject,
            release: {
              ...(sentryRelease ? { name: sentryRelease } : {}),
              ...(sentryEnvironment
                ? { deploy: { env: sentryEnvironment } }
                : {}),
            },
            telemetry: false,
          }) as PluginOption,
        ]
      : []),
  ],
  build: {
    sourcemap: Boolean(sentryAuthToken),
  },
});
