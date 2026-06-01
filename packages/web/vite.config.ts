import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, type PluginOption } from "vite";

const sentryAuthToken = process.env["SENTRY_AUTH_TOKEN"];

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
    ...(sentryAuthToken
      ? [
          sentryVitePlugin({
            authToken: sentryAuthToken,
            org: process.env["SENTRY_ORG"],
            project: process.env["SENTRY_PROJECT"],
            telemetry: false,
          }) as PluginOption,
        ]
      : []),
  ],
  build: {
    sourcemap: Boolean(sentryAuthToken),
  },
});
