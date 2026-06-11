import type { Config } from "@react-router/dev/config";
import { sentryOnBuildEnd } from "@sentry/react-router";

const sentryAuthToken = process.env["SENTRY_AUTH_TOKEN"];

export default {
  appDirectory: "app",
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
  },
  ...(sentryAuthToken
    ? {
        buildEnd: async ({
          viteConfig,
          reactRouterConfig,
          buildManifest,
        }: {
          viteConfig: unknown;
          reactRouterConfig: unknown;
          buildManifest: unknown;
        }) => {
          await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
        },
      }
    : {}),
} satisfies Config;