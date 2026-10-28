import { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { lookupPageMetadata, type CachedPageMetadata, type PageMetadata, type PageMetadataCache, type PageMetadataLookupOutcome } from "@slugbase/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { HttpEgress } from "../../src/index.ts";
import { startDnsStub, type DnsStub } from "../support/dns-stub.ts";
import { respond, startLocalServer, type Handler, type LocalServer } from "../support/local-http.ts";

// The metadata lookup behind POST /api/v1/bookmarks/metadata (doc 02 section 5.4, doc 04 section 3.2, doc 08 section 3.5, doc 10 T6 and T13), run over
// the real egress adapter: `lookupPageMetadata` is what the route calls, so the URL checks, the fetch, the answer it maps to `422 url_not_allowed` or
// `502 upstream_failed`, and the cache it writes are exercised as the route runs them. Nothing here reaches the internet: names resolve through a UDP DNS
// stub on loopback and every server listens on loopback. 127.0.0.1 stands in for a public address (the adapter lets it through by exact address) and
// 127.0.0.2 is the private address behind it that must never be reached. The failure scenario: the metadata address, and a public page that redirects to
// it, are refused (`blocked`, which the route answers `422 url_not_allowed`) and no connection is made to it.

let dns: DnsStub;
const servers: LocalServer[] = [];
let connect: MockInstance<Socket["connect"]>;

beforeAll(async () => {
  dns = await startDnsStub();
});

afterAll(async () => {
  await dns.close();
});

beforeEach(() => {
  dns.questions.length = 0;
  connect = vi.spyOn(Socket.prototype, "connect");
});

afterEach(async () => {
  connect.mockRestore();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(handler: Handler, host = "127.0.0.1", port = 0): Promise<LocalServer> {
  const server = await startLocalServer(handler, undefined, { host, port });
  servers.push(server);
  return server;
}

/** A server on 127.0.0.1 and another on 127.0.0.2 at the same port, so a name can point at either. */
async function servePair(onFirst: Handler, onSecond: Handler): Promise<[LocalServer, LocalServer]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const first = await serve(onFirst);
    try {
      return [first, await serve(onSecond, "127.0.0.2", first.port)];
    } catch {
      await first.close();
      servers.splice(servers.indexOf(first), 1);
    }
  }
  throw new Error("No free port on both loopback addresses");
}

// Every outbound connection the process attempted, as host:port. Node hands `connect` its arguments normalised: one array holding the options and the callback.
function attempts(): string[] {
  return (connect.mock.calls as unknown[][]).map(([normalised]) => {
    const [options] = normalised as [{ host?: unknown; port?: unknown }];
    return `${String(options.host)}:${String(options.port)}`;
  });
}

/** The adapter with no allowance: only public addresses can be connected to. */
const strict = () => new HttpEgress({ nodeEnv: "test", testOnly: { dnsServers: [dns.server] } });

/** The adapter that lets 127.0.0.1 stand in for a public address; every other address is still checked. */
const publicIsLoopback = () => new HttpEgress({ nodeEnv: "test", testOnly: { dnsServers: [dns.server], allowAddresses: ["127.0.0.1"] } });

const PAGE = '<!doctype html><html lang="en"><head><title>Example page</title><meta name="description" content="About the page"></head><body>Hello</body></html>';
const FETCHED: PageMetadata = { title: "Example page", description: "About the page", siteName: null, canonicalUrl: null, language: "en" };

const page: Handler = (_request, socket) => {
  respond(socket, 200, { "content-type": "text/html; charset=utf-8" }, PAGE);
};

const redirect =
  (location: string, status = 302): Handler =>
  (_request, socket) => {
    respond(socket, status, { location });
  };

function memoryCache(): PageMetadataCache & { readonly writes: { readonly url: string; readonly page: PageMetadata }[] } {
  const rows = new Map<string, CachedPageMetadata>();
  const writes: { readonly url: string; readonly page: PageMetadata }[] = [];
  return {
    writes,
    read: (url) => Promise.resolve(rows.get(url)),
    write: (url, found) => {
      writes.push({ url, page: found });
      rows.set(url, { status: "ok", ...found });
      return Promise.resolve();
    },
  };
}

async function lookup(egress: HttpEgress, cache: PageMetadataCache, url: string, budgetMs = 3_000): Promise<PageMetadataLookupOutcome> {
  return lookupPageMetadata({ egress, cache, budgetMs, now: () => performance.now() }, url);
}

describe("a page that can be read", () => {
  it("is fetched through the adapter, parsed and cached under its canonical URL", async () => {
    const server = await serve(page);
    dns.set("page.test", ["127.0.0.1"]);
    const cache = memoryCache();

    const outcome = await lookup(publicIsLoopback(), cache, `http://page.test:${String(server.port)}/Docs/?utm_source=x#top`);

    expect(outcome).toEqual({ kind: "found", page: FETCHED, cached: false });
    expect(cache.writes).toEqual([{ url: `http://page.test:${String(server.port)}/Docs`, page: FETCHED }]);
    expect(attempts()).toEqual([`127.0.0.1:${String(server.port)}`]);
    expect(server.requests.map((request) => request.target)).toEqual(["/Docs"]);
    expect(server.requests[0]?.headers["accept"]).toBe("text/html,application/xhtml+xml");
  });
});

describe("targets the adapter refuses are blocked, receive no connection and are not cached", () => {
  const literals: [string, string][] = [
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["the metadata address in decimal", `http://${String(2_852_039_166)}/latest/meta-data/`],
    ["the metadata address in hexadecimal", "http://0xa9fea9fe/"],
    ["the metadata address, dotted octal", "http://0251.0376.0251.0376/"],
    ["loopback", "http://127.0.0.1/"],
    ["loopback in decimal", "http://2130706433/"],
    ["short loopback", "http://127.1/"],
    ["RFC 1918 10.0.0.0/8", "http://10.0.0.1/"],
    ["RFC 1918 172.16.0.0/12", "http://172.16.0.1/"],
    ["RFC 1918 192.168.0.0/16", "http://192.168.1.1/"],
    ["link-local", "http://169.254.1.1/"],
    ["CGNAT", "http://100.64.0.1/"],
    ["the unspecified address", "http://0.0.0.0/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unique-local", "http://[fd00:ec2::254]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped loopback in hexadecimal", "http://[::ffff:7f00:1]/"],
    ["IPv4-mapped metadata address", "http://[::ffff:169.254.169.254]/"],
  ];

  it.each(literals)("%s (%s) is refused without asking the DNS", async (_label, url) => {
    const cache = memoryCache();

    expect(await lookup(strict(), cache, url)).toEqual({ kind: "blocked" });
    expect(dns.questions).toEqual([]);
    expect(attempts()).toEqual([]);
    expect(cache.writes).toEqual([]);
  });

  const named: [string, string][] = [
    ["RFC 1918", "10.0.0.5"],
    ["loopback", "127.0.0.2"],
    ["link-local", "169.254.1.1"],
    ["the metadata address", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["IPv6 unique-local", "fd12:3456::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.2"],
    ["IPv4-mapped metadata address", "::ffff:169.254.169.254"],
  ];

  it.each(named)("a name that resolves to %s (%s) is refused before a connection", async (_label, address) => {
    const trap = await serve(page, "127.0.0.2");
    const name = `named-${address.replaceAll(/[.:]/g, "-")}.test`;
    dns.set(name, [address]);
    const cache = memoryCache();

    expect(await lookup(publicIsLoopback(), cache, `http://${name}:${String(trap.port)}/`)).toEqual({ kind: "blocked" });
    expect(dns.questions.some((question) => question.name === name)).toBe(true);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([]);
    expect(cache.writes).toEqual([]);
  });

  it("refuses a name that answers a public and a private address, in either order", async () => {
    const [publicServer, privateServer] = await servePair(page, page);
    dns.set("both-a.test", ["127.0.0.1", "127.0.0.2"]);
    dns.set("both-b.test", ["127.0.0.2", "127.0.0.1"]);

    for (const name of ["both-a.test", "both-b.test"]) {
      expect(await lookup(publicIsLoopback(), memoryCache(), `http://${name}:${String(publicServer.port)}/`)).toEqual({ kind: "blocked" });
    }
    expect(publicServer.connections()).toBe(0);
    expect(privateServer.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });
});

describe("DNS rebinding", () => {
  it("connects to the first validated address only, so a second answer cannot move the connection", async () => {
    const [first, trap] = await servePair(page, page);
    dns.set("rebind.test", (type, ordinal) => (type === "A" ? [ordinal === 1 ? "127.0.0.1" : "127.0.0.2"] : []));

    const outcome = await lookup(publicIsLoopback(), memoryCache(), `http://rebind.test:${String(first.port)}/`);

    expect(outcome.kind).toBe("found");
    expect(first.connections()).toBe(1);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(first.port)}`]);
  });

  it("resolves the next hop afresh and refuses it when it now answers a private address", async () => {
    const [origin, trap] = await servePair(page, page);
    dns.set("hop-first.test", ["127.0.0.1"]);
    dns.set("hop-second.test", (type, ordinal) => (type === "A" ? [ordinal === 1 ? "127.0.0.2" : "127.0.0.1"] : []));
    const redirector = await serve(redirect(`http://hop-second.test:${String(trap.port)}/`));

    const outcome = await lookup(publicIsLoopback(), memoryCache(), `http://hop-first.test:${String(redirector.port)}/`);

    expect(outcome).toEqual({ kind: "blocked" });
    expect(origin.connections()).toBe(0);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(redirector.port)}`]);
  });
});

describe("redirects", () => {
  async function startOrigin(location: (trap: LocalServer) => string): Promise<{ origin: LocalServer; trap: LocalServer }> {
    const trap = await serve(page, "127.0.0.2");
    const origin = await serve(redirect(location(trap)));
    dns.set("origin.test", ["127.0.0.1"]);
    return { origin, trap };
  }

  it("follows a redirect to another public page and answers that page", async () => {
    const target = await serve(page);
    dns.set("target.test", ["127.0.0.1"]);
    const origin = await serve(redirect(`http://target.test:${String(target.port)}/final`, 301));
    dns.set("origin.test", ["127.0.0.1"]);
    const cache = memoryCache();

    const outcome = await lookup(publicIsLoopback(), cache, `http://origin.test:${String(origin.port)}/old`);

    expect(outcome).toEqual({ kind: "found", page: FETCHED, cached: false });
    expect(cache.writes.map((write) => write.url)).toEqual([`http://origin.test:${String(origin.port)}/old`]);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`, `127.0.0.1:${String(target.port)}`]);
  });

  it.each([
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["the metadata address in decimal", `http://${String(2_852_039_166)}/latest/meta-data/`],
    ["an IPv4-mapped loopback", "http://[::ffff:127.0.0.2]/"],
    ["an IPv6 unique-local address", "http://[fd00::1]/"],
    ["a CGNAT address", "http://100.64.0.1/"],
    ["a ftp URL", "ftp://127.0.0.2/file"],
    ["a file URL", "file:///etc/passwd"],
    ["a URL with credentials", "http://user:secret@origin.test/"],
  ])("a public page that redirects to %s is blocked and receives no connection", async (_label, location) => {
    const { origin, trap } = await startOrigin(() => location);
    const cache = memoryCache();

    expect(await lookup(publicIsLoopback(), cache, `http://origin.test:${String(origin.port)}/`)).toEqual({ kind: "blocked" });
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`]);
    expect(cache.writes).toEqual([]);
  });

  it("a public page that redirects to a private port on the same host is blocked", async () => {
    const { origin, trap } = await startOrigin((server) => `http://127.0.0.2:${String(server.port)}/secret`);

    expect(await lookup(publicIsLoopback(), memoryCache(), `http://origin.test:${String(origin.port)}/`)).toEqual({ kind: "blocked" });
    expect(trap.connections()).toBe(0);
  });

  it("a redirect loop and a chain longer than five hops fail", async () => {
    dns.set("loop.test", ["127.0.0.1"]);
    const looping = await serve((request, socket) => {
      respond(socket, 302, { location: `http://loop.test:${String(looping.port)}${request.target === "/a" ? "/b" : "/a"}` });
    });
    expect(await lookup(publicIsLoopback(), memoryCache(), `http://loop.test:${String(looping.port)}/a`)).toEqual({ kind: "failed" });

    let hop = 0;
    const chain = await serve((_request, socket) => {
      hop += 1;
      respond(socket, 302, { location: `http://loop.test:${String(chain.port)}/hop-${String(hop)}` });
    });
    expect(await lookup(publicIsLoopback(), memoryCache(), `http://loop.test:${String(chain.port)}/start`)).toEqual({ kind: "failed" });
    expect(chain.requests.length).toBeLessThanOrEqual(6);
  });
});

describe("failure scenario: the metadata address, directly and behind a public page (T6)", () => {
  it("answers blocked for both and makes no connection to the metadata address", async () => {
    const service = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "text/html" }, "<title>instance-credentials-marker</title>");
    }, "127.0.0.2");
    const origin = await serve(redirect(`http://127.0.0.2:${String(service.port)}/latest/meta-data/`));
    dns.set("evil.test", ["127.0.0.1"]);
    const cache = memoryCache();

    const direct = await lookup(publicIsLoopback(), cache, "http://169.254.169.254/");
    const behind = await lookup(publicIsLoopback(), cache, `http://evil.test:${String(origin.port)}/page`);

    expect(direct).toEqual({ kind: "blocked" });
    expect(behind).toEqual({ kind: "blocked" });
    expect(service.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`]);
    expect(attempts().some((attempt) => attempt.startsWith("169.254."))).toBe(false);
    expect(cache.writes).toEqual([]);
  });
});

describe("pages that cannot be read", () => {
  it.each([
    ["application/json", "application/json"],
    ["text/plain", "text/plain"],
    ["image/png", "image/png"],
    ["application/pdf", "application/pdf"],
    ["a response with no type", undefined],
  ])("%s is failed and not cached", async (_label, contentType) => {
    const server = await serve((_request, socket) => {
      respond(socket, 200, contentType === undefined ? {} : { "content-type": contentType }, PAGE);
    });
    const cache = memoryCache();

    expect(await lookup(publicIsLoopback(), cache, `http://127.0.0.1:${String(server.port)}/`)).toEqual({ kind: "failed" });
    expect(cache.writes).toEqual([]);
  });

  it.each([404, 410, 500, 503])("a %i answer is failed and not cached", async (status) => {
    const server = await serve((_request, socket) => {
      respond(socket, status, { "content-type": "text/html" }, PAGE);
    });
    const cache = memoryCache();

    expect(await lookup(publicIsLoopback(), cache, `http://127.0.0.1:${String(server.port)}/`)).toEqual({ kind: "failed" });
    expect(cache.writes).toEqual([]);
  });

  it("a connection that is refused is failed", async () => {
    const closed = await serve(page);
    const { port } = closed;
    await closed.close();
    servers.splice(servers.indexOf(closed), 1);

    expect(await lookup(publicIsLoopback(), memoryCache(), `http://127.0.0.1:${String(port)}/`)).toEqual({ kind: "failed" });
  });
});

describe("oversized and slow bodies are cut off", () => {
  const head = (extra: Record<string, string>): string =>
    `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n${Object.entries(extra)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("")}\r\n`;

  it("reads the first 512 KiB of a body that never ends, answers what is in it, and closes the connection", async () => {
    let written = 0;
    let closed: () => void = () => undefined;
    const serverSawClose = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const endless = await serve((_request, socket) => {
      socket.on("close", closed);
      socket.write(head({ "transfer-encoding": "chunked" }));
      const chunk = Buffer.from("<title>Endless</title>".padEnd(8_192, " "));
      const writeChunk = (): void => {
        if (socket.destroyed) {
          return;
        }
        written += chunk.length;
        const ok = socket.write(`${chunk.length.toString(16)}\r\n`) && socket.write(chunk) && socket.write("\r\n");
        if (ok) {
          setImmediate(writeChunk);
        } else {
          socket.once("drain", writeChunk);
        }
      };
      writeChunk();
    });
    const cache = memoryCache();

    const outcome = await lookup(publicIsLoopback(), cache, `http://127.0.0.1:${String(endless.port)}/`);
    await serverSawClose;

    expect(outcome).toMatchObject({ kind: "found", page: { title: "Endless" } });
    expect(written).toBeLessThan(64 * 1024 * 1024);
    expect(cache.writes).toHaveLength(1);
  }, 20_000);

  it("reads at most 512 KiB of a body whose declared length is far larger", async () => {
    const declared = 200 * 1024 * 1024;
    const large = await serve((_request, socket) => {
      socket.write(head({ "content-length": String(declared) }));
      socket.write(Buffer.from(`<title>Large</title>${" ".repeat(600 * 1024)}`));
    });

    const outcome = await lookup(publicIsLoopback(), memoryCache(), `http://127.0.0.1:${String(large.port)}/`);

    expect(outcome).toMatchObject({ kind: "found", page: { title: "Large" } });
  }, 20_000);

  it("cuts a gzip bomb off at 512 KiB of the decoded body", async () => {
    const bomb = gzipSync(Buffer.from(`<title>Bomb</title>${" ".repeat(64 * 1024 * 1024)}`));
    const server = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "text/html", "content-encoding": "gzip" }, bomb);
    });

    const outcome = await lookup(publicIsLoopback(), memoryCache(), `http://127.0.0.1:${String(server.port)}/`);

    expect(outcome).toMatchObject({ kind: "found", page: { title: "Bomb" } });
  }, 20_000);

  it("fails a body that stalls, within the budget, and caches nothing", async () => {
    const stalled = await serve((_request, socket) => {
      socket.write(head({ "content-length": "100000" }));
      socket.write("<title>Slow</title>");
    });
    const cache = memoryCache();
    const started = performance.now();

    const outcome = await lookup(publicIsLoopback(), cache, `http://127.0.0.1:${String(stalled.port)}/`, 400);

    expect(outcome).toEqual({ kind: "failed" });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(cache.writes).toEqual([]);
  });

  it("fails a server that never answers, within the budget", async () => {
    const silent = await serve(() => undefined);
    const started = performance.now();

    const outcome = await lookup(publicIsLoopback(), memoryCache(), `http://127.0.0.1:${String(silent.port)}/`, 400);

    expect(outcome).toEqual({ kind: "failed" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("shares one budget across the redirect hops", async () => {
    const slow = await serve(() => undefined);
    const origin = await serve(redirect(`http://127.0.0.1:${String(slow.port)}/`));
    const started = performance.now();

    const outcome = await lookup(publicIsLoopback(), memoryCache(), `http://127.0.0.1:${String(origin.port)}/`, 400);

    expect(outcome).toEqual({ kind: "failed" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("a URL that is not a bookmark URL is refused before any lookup", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "ftp://127.0.0.1/", "//127.0.0.1/", "gopher://127.0.0.1/"])(
    "%s",
    async (url) => {
      const outcome = await lookup(publicIsLoopback(), memoryCache(), url);

      expect(outcome).toEqual({ kind: "url_refused", reason: "not_http" });
      expect(dns.questions).toEqual([]);
      expect(attempts()).toEqual([]);
    },
  );
});
