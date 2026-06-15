import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { generateCspNonce } from "./security/csp-nonce.js";
import { applyDocumentSecurityHeaders } from "./security/http-security-headers.js";
import { NonceProvider } from "./security/nonce-context.js";

/**
 * Cloudflare Workers SSR entry (spec §19). Node self-host uses the same stream API on React 19.
 * Default React Router node entry uses renderToPipeableStream, which Workers do not support.
 *
 * CSP uses a per-request nonce (see `security/http-security-headers.ts` and React Router security guide).
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  const userAgent = request.headers.get("user-agent");
  const isHttps = new URL(request.url).protocol === "https:";
  const cspNonce = generateCspNonce();

  applyDocumentSecurityHeaders(responseHeaders, {
    cspNonce,
    isDev: import.meta.env.DEV,
    isHttps,
  });

  const body = await renderToReadableStream(
    <NonceProvider nonce={cspNonce}>
      <ServerRouter context={routerContext} url={request.url} nonce={cspNonce} />
    </NonceProvider>,
    {
      nonce: cspNonce,
      onError(_error: unknown) {
        responseStatusCode = 500;
      },
    },
  );

  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
