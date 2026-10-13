import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { MOCK_MODE, mockPlugin } from "./mock/vite-plugin.ts";

const SERVER = "http://127.0.0.1:3000";
const PROXY: Record<string, string> = { "/api": SERVER, "/go": SERVER, "/health": SERVER };
const PACKAGES = resolve(import.meta.dirname, "../../packages");

// One origin in development (D11, doc 08 section 1.3): the browser only sees the
// Vite port, and the paths the server owns go to it. Mock mode (`pnpm dev:web
// --mock`, doc 08 section 7) has no server: the service worker answers the API.
export default defineConfig(({ command, mode }) => {
  const mock = command === "serve" && mode === MOCK_MODE;
  return {
    root: import.meta.dirname,
    plugins: [
      tailwindcss(),
      ...(mock
        ? [
            mockPlugin({
              documentPath: resolve(PACKAGES, "contracts/generated/openapi.json"),
              handlersEntry: resolve(PACKAGES, "testing/src/msw.ts"),
            }),
          ]
        : []),
    ],
    resolve: {
      // The dev server reads the web app and the UI from their sources, so an edit
      // shows without a rebuild; a build reads the packages as published.
      alias:
        command === "serve"
          ? [
              { find: /^@slugbase\/web$/, replacement: resolve(PACKAGES, "web/src/index.ts") },
              { find: /^@slugbase\/ui$/, replacement: resolve(PACKAGES, "ui/src/index.ts") },
            ]
          : [],
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: mock ? {} : PROXY,
    },
    build: {
      outDir: "dist/web",
      emptyOutDir: true,
      // No preload polyfill: the page carries one external module script and nothing inline, as the CSP of E1.4.6 requires.
      modulePreload: { polyfill: false },
      rolldownOptions: {
        // React Server Component markers in dependencies mean nothing to a client-only bundle.
        onLog(level, log, defaultHandler) {
          if (log.code !== "MODULE_LEVEL_DIRECTIVE") {
            defaultHandler(level, log);
          }
        },
      },
    },
  };
});
