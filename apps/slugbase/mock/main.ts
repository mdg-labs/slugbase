import { createHandlers, scenarioFromSearch } from "@slugbase/testing/msw";
import { setupWorker } from "msw/browser";
import openApiDocument from "virtual:slugbase-openapi";

// The entry of `pnpm dev:web --mock`: the service worker answers the API from
// the handlers generated from openapi.json, then the app starts as it does in
// production. The page picks a scenario with ?scenario=<name>.

const worker = setupWorker(
  ...createHandlers(openApiDocument, { scenario: scenarioFromSearch(globalThis.location.search) }),
);

await worker.start({
  // A request to the API that no handler answers is an error; assets and the dev server's own requests pass.
  onUnhandledRequest(request, print) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      print.error();
    }
  },
});

await import("../src/web.tsx");
