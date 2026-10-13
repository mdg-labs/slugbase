import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Mock mode of the dev server (doc 08 section 7): the page loads mock/main.ts in
// place of the app entry, the document the handlers are generated from reaches
// the browser as a virtual module, and the service worker script is served from
// the msw package. Nothing here is a file of the build: the plugin is added to a
// serve command in mode "mock" only, and index.html names the app entry.

export const MOCK_MODE = "mock";

const APP_ENTRY = "/src/web.tsx";
const MOCK_ENTRY = "/mock/main.ts";
const WORKER_PATH = "/mockServiceWorker.js";
const DOCUMENT_MODULE = "virtual:slugbase-openapi";
const RESOLVED_DOCUMENT_MODULE = `\0${DOCUMENT_MODULE}`;

export interface MockPluginOptions {
  /** The committed OpenAPI document the handlers are generated from. */
  readonly documentPath: string;
  /** The source of `@slugbase/testing/msw`, so an edit to the handlers shows without a rebuild. */
  readonly handlersEntry: string;
}

export function mockPlugin(options: MockPluginOptions): Plugin {
  return {
    name: "slugbase-mock",
    apply: "serve",
    config: () => ({
      resolve: { alias: [{ find: /^@slugbase\/testing\/msw$/, replacement: options.handlersEntry }] },
    }),
    resolveId(id) {
      return id === DOCUMENT_MODULE ? RESOLVED_DOCUMENT_MODULE : undefined;
    },
    load(id) {
      return id === RESOLVED_DOCUMENT_MODULE
        ? `export default ${readFileSync(resolve(options.documentPath), "utf8")};`
        : undefined;
    },
    configureServer(server) {
      const worker = createRequire(import.meta.url).resolve("msw/mockServiceWorker.js");
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== WORKER_PATH) {
          next();
          return;
        }
        response.setHeader("Content-Type", "text/javascript");
        response.setHeader("Cache-Control", "no-cache");
        response.end(readFileSync(worker));
      });
    },
    transformIndexHtml(html) {
      if (!html.includes(APP_ENTRY)) {
        throw new Error(`index.html does not load ${APP_ENTRY}, so mock mode cannot replace the entry`);
      }
      return html.replace(APP_ENTRY, MOCK_ENTRY);
    },
  };
}
