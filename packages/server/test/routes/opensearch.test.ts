import { describe, expect, it } from "vitest";
import type { BuildInfo } from "../../src/build-info.ts";
import { createServer } from "../../src/create-server.ts";
import { openSearchDocument } from "../../src/routes/opensearch.ts";
import { adapters, fakeAuthStore, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// GET /opensearch.xml (doc 04 section 9.4) through the whole chain: the document is built from the configured origin and the product
// name and from nothing the request carries. The failure scenario is a document that follows the request's own idea of the host
// (`Host`, `X-Forwarded-Host`, `Forwarded`), which would let a request point the search URL a browser stores at another site.

const ORIGIN = "https://links.example.org";
const BUILD: BuildInfo = { name: "SlugBase", version: "1.4.2", commit: "0123abc", builtAt: "2026-10-12T08:00:00Z" };

function start(env: Record<string, string | undefined> = {}, build: BuildInfo = BUILD) {
  const config = serverConfig({ APP_ORIGIN: ORIGIN, ...env });
  return createServer({
    config,
    adapters: adapters(config),
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
    authStore: fakeAuthStore(),
    buildInfo: build,
  });
}

type Started = ReturnType<typeof start>;

const get = (server: Started, headers: Record<string, string> = {}) => server.fetch(new Request("http://localhost/opensearch.xml", { headers }));

describe("GET /opensearch.xml", () => {
  it("answers without a session, as an OpenSearch description whose search URL is the go address on the configured origin", async () => {
    const response = await get(start());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/opensearchdescription+xml; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await response.text();
    expect(body).toContain('<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">');
    expect(body).toContain("<ShortName>SlugBase</ShortName>");
    expect(body).toContain(`<Url type="text/html" method="get" template="${ORIGIN}/go/{searchTerms}"/>`);
  });

  it("contains no origin but the configured one when the request forges its Host, X-Forwarded-Host or Forwarded", async () => {
    const plain = await (await get(start())).text();
    const forged = {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      "x-forwarded-for": "203.0.113.9",
      forwarded: "host=evil.example;proto=http",
    };

    for (const hops of ["0", "1"]) {
      const response = await get(start({ TRUSTED_PROXY_HOPS: hops }), forged);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe(plain);
      expect(body).not.toContain("evil.example");
      const hosts = [...body.matchAll(/https?:\/\/[^\s"'<>/]+/g)].map((match) => match[0]);
      expect(new Set(hosts)).toEqual(new Set(["http://a9.com", ORIGIN]));
    }
  });

  it("is limited by the public bucket per address", async () => {
    const server = start({ RATE_LIMIT_PUBLIC_IP: "2/min" });

    const statuses = [(await get(server)).status, (await get(server)).status, (await get(server)).status];

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("is served over a named product, escaped and with the short name cut to OpenSearch's 16 characters", async () => {
    const response = await get(start({}, { ...BUILD, name: 'Acme & "Sons" Bookmarks' }));

    const body = await response.text();
    expect(body).toContain("<ShortName>Acme &amp; &quot;Sons&quot; Bo</ShortName>");
    expect(body).toContain("<Description>Go to a Acme &amp; &quot;Sons&quot; Bookmarks slug</Description>");
  });
});

describe("openSearchDocument", () => {
  it("escapes what it is built from, so neither a product name nor an origin can add markup", () => {
    const body = openSearchDocument('https://a.example/"><x/>', "<b>&</b>");

    expect(body).not.toContain("<x/>");
    expect(body).not.toContain("<b>");
    expect(body).toContain('template="https://a.example/&quot;&gt;&lt;x/&gt;/go/{searchTerms}"');
  });

  it("does not cut a character in the middle when it shortens the short name", () => {
    const body = openSearchDocument(ORIGIN, "😀".repeat(20));

    expect(body).toContain(`<ShortName>${"😀".repeat(16)}</ShortName>`);
  });
});
