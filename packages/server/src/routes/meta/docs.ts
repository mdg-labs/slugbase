import { readFileSync } from "node:fs";
import type { ChainContext } from "../../http/chain.ts";

// GET /api/docs (doc 04 section 1.4): the Scalar reference UI, from the assets
// of the installed @scalar/api-reference package and nothing fetched from
// anywhere else. The page holds no inline script or style: the configuration is
// data in an attribute of a script element that is never run, and the code and
// the stylesheet are files served from the same origin, so the page runs under
// `script-src 'self'` with no hash, nonce or `unsafe-inline` (doc 01 section 4
// step 2, doc 10 T14).

const PAGE = "/api/docs";
const SCRIPT = "/api/docs/scalar.js";
const STYLESHEET = "/api/docs/scalar.css";
const DOCUMENT = "/api/v1/openapi.json";

// The reference reads this from the element with id `api-reference`. Fonts, the
// developer tools, the AI agent and the MCP integration (each of which links to
// the vendor's hosted services) and telemetry are off, and no request proxy is
// set, so a request made from the page goes to this server only.
const CONFIGURATION = JSON.stringify({
  url: DOCUMENT,
  withDefaultFonts: false,
  showDeveloperTools: "never",
  telemetry: false,
  agent: { disabled: true },
  mcp: { disabled: true },
  hideClientButton: true,
});

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SlugBase API reference</title>
<link rel="stylesheet" href="${STYLESHEET}">
</head>
<body>
<script id="api-reference" type="application/json" data-url="${DOCUMENT}" data-configuration='${CONFIGURATION}'></script>
<script src="${SCRIPT}"></script>
</body>
</html>
`;

interface Asset {
  readonly contentType: string;
  readonly body: string;
}

// The package restricts its exports, so the files are found beside its entry point.
function packageFile(relative: string): URL {
  return new URL(relative, import.meta.resolve("@scalar/api-reference"));
}

/**
 * The reference page and its two files, read when the server is composed so a
 * package that is missing its assets stops the start instead of the first visit.
 */
function assets(): ReadonlyMap<string, Asset> {
  return new Map<string, Asset>([
    [PAGE, { contentType: "text/html; charset=utf-8", body: HTML }],
    [`${PAGE}/`, { contentType: "text/html; charset=utf-8", body: HTML }],
    [SCRIPT, { contentType: "text/javascript; charset=utf-8", body: readFileSync(packageFile("./browser/standalone.js"), "utf8") }],
    [STYLESHEET, { contentType: "text/css; charset=utf-8", body: readFileSync(packageFile("./style.css"), "utf8") }],
  ]);
}

/**
 * Answers `GET` and `HEAD` for the reference page and its files, and nothing
 * else: any other request is left to the rest of the chain.
 */
export function apiDocs(): (context: ChainContext) => Response | undefined {
  const served = assets();
  return (context) => {
    const method = context.req.method;
    if (method !== "GET" && method !== "HEAD") {
      return undefined;
    }
    const asset = served.get(new URL(context.req.url).pathname);
    if (asset === undefined) {
      return undefined;
    }
    return new Response(method === "HEAD" ? null : asset.body, { status: 200, headers: { "content-type": asset.contentType } });
  };
}
