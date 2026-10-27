import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { pipeline } from "node:stream";

export interface TlsProxyOptions {
  /** The port to listen on, on 127.0.0.1. */
  readonly port: number;
  /** The plain-http address of the server, as `http://127.0.0.1:<port>`. */
  readonly upstream: URL;
  readonly keyFile: string;
  readonly certFile: string;
}

/**
 * Serves the application over https, so that a browser reaches it at the https
 * origin the server is configured with (its session cookie is Secure and it refuses a
 * mutation from any other origin). The request is forwarded as it is, headers
 * included; nothing is added or taken out. Returns a function that stops the proxy.
 *
 * Playwright's request contexts keep their sockets open between requests with no idle limit. A server
 * that closes an idle socket after a timeout (Node's default is 5 s) can do so just as a client writes
 * the next request on it, which the client sees as `socket hang up (ECONNRESET)`. The proxy therefore
 * never times out an idle connection; the stop function closes them all.
 */
export async function startTlsProxy({ port, upstream, keyFile, certFile }: TlsProxyOptions): Promise<() => Promise<void>> {
  const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (incoming, outgoing) => {
    // A browser that cancels a navigation or a fetch closes the connection while the upstream is still
    // working; the answer that arrives later has nowhere to go and is discarded.
    let clientGone = false;
    const forwarded = httpRequest(
      { host: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url, headers: incoming.headers },
      (answer) => {
        if (clientGone || outgoing.destroyed || outgoing.writableEnded) {
          answer.destroy();
          return;
        }
        outgoing.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
        pipeline(answer, outgoing, () => undefined);
      },
    );
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) {
        clientGone = true;
        forwarded.destroy();
      }
    });
    forwarded.on("error", () => {
      if (clientGone) {
        return;
      }
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
      }
      outgoing.end();
    });
    pipeline(incoming, forwarded, () => undefined);
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
}
