import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The place a /go journey forwards to (doc 08 section 5.1): a page served from the loopback address of the machine that runs the
// browser, so a forward is seen to arrive without the journey leaving the machine. The page is a complete, accessible document
// (a language, a title, a main landmark and a heading), so the accessibility check can scan it like any other page the journey ends on.

export interface Destination {
  /** The origin the page is served from, such as `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** The address of a path on the page's origin. */
  url: (path: string) => string;
  /** The `path?query` of every request the page has received, in the order they came. */
  requests: () => readonly string[];
  close: () => Promise<void>;
}

const HEADING = "Journey destination";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

/** The heading of the page every path of the destination answers with. */
export const DESTINATION_HEADING = HEADING;

/** Starts the destination on a free port of the loopback address. */
export async function startDestination(): Promise<Destination> {
  const received: string[] = [];
  const server: Server = createServer((request, response) => {
    const target = request.url ?? "/";
    // A browser asks for the icon of a page by itself; it is not something the journey sent it to.
    if (target === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    received.push(target);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${HEADING}</title></head>` +
        `<body><main><h1>${HEADING}</h1><p>${escapeHtml(target)}</p></main></body></html>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    requests: () => received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        server.closeAllConnections();
      }),
  };
}
