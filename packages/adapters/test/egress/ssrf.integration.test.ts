import { Socket } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EgressBlocked, EgressError, EgressTimeout, EgressTooLarge, type EgressRequest } from "@slugbase/core";
import { HttpEgress } from "../../src/index.ts";
import { startDnsStub, type DnsStub } from "../support/dns-stub.ts";
import { respond, startLocalServer, type Handler, type LocalServer } from "../support/local-http.ts";

// egress/ssrf (doc 08 section 3.5, T6). Nothing here reaches the internet: names resolve through a
// UDP DNS stub on loopback, and every server listens on loopback. The adapter resolves with its own
// resolver pointed at the stub. Loopback stands in for "public" where a connection has to succeed:
// 127.0.0.1 is let through by exact address, and 127.0.0.2 is the private address behind it that must
// never be reached. A refused target must see no connection, and the adapter must not even try one,
// so every case also checks the connection attempts the process made.

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

const ok: Handler = (_request, socket) => {
  respond(socket, 200, { "content-type": "text/plain" }, "hello");
};

const redirect =
  (location: string, status = 302): Handler =>
  (_request, socket) => {
    respond(socket, status, { location });
  };

// Every outbound connection the process attempted, as host:port. Node hands `connect` its arguments
// normalised: one array holding the options and the callback.
function attempts(): string[] {
  return (connect.mock.calls as unknown[][]).map(([normalised]) => {
    const [options] = normalised as [{ host?: unknown; port?: unknown }];
    return `${String(options.host)}:${String(options.port)}`;
  });
}

/** The adapter with no allowance: only public addresses can be connected to. */
const strict = () => new HttpEgress({ nodeEnv: "test", testOnly: { dnsServers: [dns.server] } });

/** The adapter that lets 127.0.0.1 stand in for a public address; every other address is still checked. */
const publicIsLoopback = () =>
  new HttpEgress({ nodeEnv: "test", testOnly: { dnsServers: [dns.server], allowAddresses: ["127.0.0.1"] } });

const get = (url: string, extra: Partial<EgressRequest> = {}): EgressRequest =>
  ({ url, timeoutMs: 2_000, maxBytes: 1_000, ...extra }) as EgressRequest;

async function rejection(egress: HttpEgress, request: EgressRequest): Promise<unknown> {
  return egress.request(request).then(
    () => undefined,
    (error: unknown) => error,
  );
}

function questionsFor(name: string): string[] {
  return dns.questions.filter((question) => question.name === name).map((question) => question.type);
}

describe("resolving through the DNS stub", () => {
  it("asks the stub for A and AAAA records and connects to the address it answers", async () => {
    const server = await serve(ok);
    dns.set("stubbed.test", ["127.0.0.1"]);
    const response = await publicIsLoopback().request(get(`http://stubbed.test:${String(server.port)}/`));
    expect(response.status).toBe(200);
    expect(questionsFor("stubbed.test").sort()).toEqual(["A", "AAAA"]);
    expect(attempts()).toEqual([`127.0.0.1:${String(server.port)}`]);
    expect(server.requests[0]?.headers["host"]).toBe(`stubbed.test:${String(server.port)}`);
  });

  it("refuses a name the stub does not know, without a connection", async () => {
    const server = await serve(ok);
    const error = await rejection(strict(), get(`http://unknown.test:${String(server.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(questionsFor("unknown.test").length).toBeGreaterThan(0);
    expect(server.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  it("is refused in production, and is not combined with a resolver", () => {
    expect(() => new HttpEgress({ nodeEnv: "production", testOnly: { dnsServers: [dns.server] } })).toThrow();
    expect(
      () =>
        new HttpEgress({
          nodeEnv: "test",
          resolve: () => Promise.resolve([]),
          testOnly: { dnsServers: [dns.server] },
        }),
    ).toThrow();
  });
});

describe("refused targets receive no connection", () => {
  const named: [string, string][] = [
    ["RFC 1918 10.0.0.0/8", "10.0.0.1"],
    ["RFC 1918 10.0.0.0/8, top", "10.255.255.254"],
    ["RFC 1918 172.16.0.0/12", "172.16.0.1"],
    ["RFC 1918 172.16.0.0/12, top", "172.31.255.254"],
    ["RFC 1918 192.168.0.0/16", "192.168.1.1"],
    ["loopback", "127.0.0.1"],
    ["loopback, other address", "127.0.0.2"],
    ["loopback, top", "127.255.255.254"],
    ["link-local", "169.254.1.1"],
    ["the metadata address", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["CGNAT, top", "100.127.255.254"],
    ["the unspecified address", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local fc00::/7", "fc00::1"],
    ["IPv6 unique-local fd00::/8", "fd12:3456::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback in hexadecimal", "::ffff:7f00:1"],
    ["IPv4-mapped RFC 1918", "::ffff:10.0.0.1"],
    ["IPv4-mapped metadata address", "::ffff:169.254.169.254"],
  ];

  it.each(named)("refuses a name that resolves to %s (%s)", async (_label, address) => {
    const trap = await serve(ok);
    const name = `refused-${address.replaceAll(/[.:]/g, "-")}.test`;
    dns.set(name, [address]);
    const error = await rejection(strict(), get(`http://${name}:${String(trap.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(questionsFor(name).length).toBeGreaterThan(0);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  const metadata = 2_852_039_166; // 169.254.169.254
  const literals: [string, string][] = [
    ["decimal loopback", "2130706433"],
    ["octal loopback", "017700000001"],
    ["hexadecimal loopback", "0x7f000001"],
    ["dotted octal loopback", "0177.0.0.1"],
    ["dotted hexadecimal loopback", "0x7f.0.0.1"],
    ["short loopback", "127.1"],
    ["mixed-notation loopback", "0x7f.0.0.01"],
    ["decimal metadata address", String(metadata)],
    ["octal metadata address", `0${metadata.toString(8)}`],
    ["hexadecimal metadata address", `0x${metadata.toString(16)}`],
    ["dotted octal metadata address", "0251.0376.0251.0376"],
    ["short RFC 1918", "10.1"],
    ["decimal RFC 1918", String(0xc0a80001)],
    ["decimal CGNAT", String(0x64400001)],
    ["plain loopback", "127.0.0.1"],
    ["IPv6 loopback", "[::1]"],
    ["IPv6 unique-local", "[fd00::1]"],
    ["IPv6 link-local", "[fe80::1]"],
    ["IPv4-mapped loopback", "[::ffff:127.0.0.1]"],
    ["IPv4-mapped loopback in hexadecimal", "[::ffff:7f00:1]"],
    ["IPv4-mapped metadata address", "[::ffff:a9fe:a9fe]"],
  ];

  it.each(literals)("refuses the literal %s (%s) without asking the DNS or connecting", async (_label, host) => {
    const trap = await serve(ok);
    const error = await rejection(strict(), get(`http://${host}:${String(trap.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(dns.questions).toEqual([]);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  it("refuses an address the test allowance names only when it is exactly that address", async () => {
    const [allowed, other] = await servePair(ok, ok);
    const egress = publicIsLoopback();
    expect((await egress.request(get(`http://127.0.0.1:${String(allowed.port)}/`))).status).toBe(200);
    expect(await rejection(egress, get(`http://127.0.0.2:${String(other.port)}/`))).toBeInstanceOf(EgressBlocked);
    expect(other.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(allowed.port)}`]);
  });
});

describe("DNS rebinding", () => {
  it("connects to the first validated address only, and resolves the name once", async () => {
    const [first, trap] = await servePair(ok, ok);
    dns.set("rebind.test", (type, ordinal) => (type === "A" ? [ordinal === 1 ? "127.0.0.1" : "127.0.0.2"] : []));
    const response = await publicIsLoopback().request(get(`http://rebind.test:${String(first.port)}/`));
    expect(response.status).toBe(200);
    expect(first.connections()).toBe(1);
    expect(trap.connections()).toBe(0);
    expect(questionsFor("rebind.test").filter((type) => type === "A")).toHaveLength(1);
    expect(attempts()).toEqual([`127.0.0.1:${String(first.port)}`]);
  });

  it("refuses a name that answers a public and a private address, in either order", async () => {
    const [publicServer, privateServer] = await servePair(ok, ok);
    dns.set("both-a.test", ["127.0.0.1", "127.0.0.2"]);
    dns.set("both-b.test", ["127.0.0.2", "127.0.0.1"]);
    for (const name of ["both-a.test", "both-b.test"]) {
      expect(await rejection(publicIsLoopback(), get(`http://${name}:${String(publicServer.port)}/`))).toBeInstanceOf(EgressBlocked);
    }
    expect(publicServer.connections()).toBe(0);
    expect(privateServer.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  it("refuses a name whose IPv4 answer is public and whose IPv6 answer is private", async () => {
    const server = await serve(ok);
    dns.set("dual.test", ["127.0.0.1", "fd00::1"]);
    expect(await rejection(publicIsLoopback(), get(`http://dual.test:${String(server.port)}/`))).toBeInstanceOf(EgressBlocked);
    expect(server.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  it("resolves a name afresh at the next hop and refuses it when it now answers a private address", async () => {
    const [origin, trap] = await servePair(ok, ok);
    dns.set("hop-first.test", ["127.0.0.1"]);
    dns.set("hop-second.test", (type, ordinal) => (type === "A" ? [ordinal === 1 ? "127.0.0.2" : "127.0.0.1"] : []));
    const redirector = await serve(redirect(`http://hop-second.test:${String(trap.port)}/`));
    const error = await rejection(publicIsLoopback(), get(`http://hop-first.test:${String(redirector.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(origin.connections()).toBe(0);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(redirector.port)}`]);
  });
});

describe("redirects", () => {
  async function startOrigin(location: (trap: LocalServer) => string): Promise<{ origin: LocalServer; trap: LocalServer }> {
    const trap = await serve(ok, "127.0.0.2");
    const origin = await serve(redirect(location(trap)));
    dns.set("origin.test", ["127.0.0.1"]);
    return { origin, trap };
  }

  it("refuses a redirect from a public address to a private address", async () => {
    const { origin, trap } = await startOrigin((server) => `http://127.0.0.2:${String(server.port)}/secret`);
    const error = await rejection(publicIsLoopback(), get(`http://origin.test:${String(origin.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(origin.requests).toHaveLength(1);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`]);
  });

  it("refuses a redirect to a public name that resolves privately", async () => {
    const { origin, trap } = await startOrigin((server) => `http://inner.test:${String(server.port)}/secret`);
    dns.set("inner.test", ["127.0.0.2"]);
    const error = await rejection(publicIsLoopback(), get(`http://origin.test:${String(origin.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(questionsFor("inner.test").length).toBeGreaterThan(0);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`]);
  });

  it.each([
    ["ftp", "ftp://127.0.0.2/file"],
    ["file", "file:///etc/passwd"],
    ["gopher", "gopher://127.0.0.2/"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/plain,secret"],
    ["http with credentials", "http://user:secret@origin.test/"],
  ])("refuses a redirect to a %s URL", async (_label, location) => {
    const { origin, trap } = await startOrigin(() => location);
    const error = await rejection(publicIsLoopback(), get(`http://origin.test:${String(origin.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`]);
  });

  it.each([
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["the metadata address in decimal", `http://${String(2_852_039_166)}/latest/meta-data/`],
    ["an IPv4-mapped loopback", "http://[::ffff:127.0.0.2]/"],
    ["an IPv6 unique-local address", "http://[fd00::1]/"],
    ["a CGNAT address", "http://100.64.0.1/"],
  ])("refuses a redirect to %s", async (_label, location) => {
    const { origin, trap } = await startOrigin(() => location);
    const error = await rejection(publicIsLoopback(), get(`http://origin.test:${String(origin.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(origin.port)}`]);
  });
});

describe("failure scenario: a favicon redirect to the metadata address (doc 10 section 6, High)", () => {
  // A hostile site answers the favicon request with a redirect to the metadata service, hoping the
  // fetcher follows it and serves the body back. A stand-in for that service holds a marker value.
  const SECRET = "instance-credentials-marker";
  const faviconRequest = (port: number) =>
    get(`http://evil.test:${String(port)}/favicon.ico`, { acceptContentTypes: ["image/x-icon", "image/png"] });

  it("serves the internal response back when the redirect is let through, so the test sees the attack", async () => {
    const service = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "image/png" }, SECRET);
    }, "127.0.0.2");
    const evil = await serve(redirect(`http://127.0.0.2:${String(service.port)}/latest/meta-data/`));
    dns.set("evil.test", ["127.0.0.1"]);
    const permissive = new HttpEgress({
      nodeEnv: "test",
      testOnly: { dnsServers: [dns.server], allowAddresses: ["127.0.0.1", "127.0.0.2"] },
    });
    const response = await permissive.request(faviconRequest(evil.port));
    expect(new TextDecoder().decode(response.body)).toBe(SECRET);
    expect(service.connections()).toBe(1);
  });

  it("refuses the same redirect and never connects to the internal address", async () => {
    const service = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "image/png" }, SECRET);
    }, "127.0.0.2");
    const evil = await serve(redirect(`http://127.0.0.2:${String(service.port)}/latest/meta-data/`));
    dns.set("evil.test", ["127.0.0.1"]);
    const outcome = await publicIsLoopback().request(faviconRequest(evil.port)).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    expect(outcome).toHaveProperty("error");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(EgressBlocked);
    expect(service.connections()).toBe(0);
    expect(attempts()).toEqual([`127.0.0.1:${String(evil.port)}`]);
  });

  it("refuses the redirect to the real metadata address and to a name that resolves to it", async () => {
    dns.set("evil.test", ["127.0.0.1"]);
    dns.set("metadata.test", ["169.254.169.254"]);
    for (const location of ["http://169.254.169.254/latest/meta-data/", "http://metadata.test/latest/meta-data/"]) {
      const evil = await serve(redirect(location));
      const error = await rejection(publicIsLoopback(), faviconRequest(evil.port));
      expect(error).toBeInstanceOf(EgressBlocked);
      expect(evil.requests).toHaveLength(1);
    }
    expect(attempts().filter((target) => target.startsWith("169.254."))).toEqual([]);
    expect(attempts()).toHaveLength(2);
  });
});

describe("the caps", () => {
  beforeEach(() => {
    dns.set("caps.test", ["127.0.0.1"]);
  });
  const url = (server: LocalServer): string => `http://caps.test:${String(server.port)}/`;

  it("cuts a slow response at the deadline", async () => {
    const trickle = await serve((_request, socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 1000\r\n\r\n");
      const timer = setInterval(() => {
        if (socket.destroyed) {
          clearInterval(timer);
          return;
        }
        socket.write("x");
      }, 20);
    });
    const silent = await serve(() => undefined);
    for (const server of [trickle, silent]) {
      const started = Date.now();
      const error = await rejection(publicIsLoopback(), get(url(server), { timeoutMs: 250 }));
      expect(error).toBeInstanceOf(EgressTimeout);
      expect(Date.now() - started).toBeLessThan(1_500);
    }
  });

  it("refuses a body over the limit when the length is declared", async () => {
    const server = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "text/plain" }, "x".repeat(5_000));
    });
    const error = await rejection(publicIsLoopback(), get(url(server), { maxBytes: 1_000 }));
    expect(error).toBeInstanceOf(EgressTooLarge);
  });

  it("cuts a body over the limit when no length is declared, and closes the connection", async () => {
    let closed = false;
    const server = await serve((_request, socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n");
      const chunk = `400\r\n${"x".repeat(1024)}\r\n`;
      const timer = setInterval(() => {
        if (socket.destroyed) {
          clearInterval(timer);
          return;
        }
        socket.write(chunk);
      }, 5);
      socket.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
    });
    const error = await rejection(publicIsLoopback(), get(url(server), { maxBytes: 4_000 }));
    expect(error).toBeInstanceOf(EgressTooLarge);
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
  });

  it("accepts a body of exactly the limit", async () => {
    const server = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "text/plain" }, "x".repeat(1_000));
    });
    expect((await publicIsLoopback().request(get(url(server), { maxBytes: 1_000 }))).body).toHaveLength(1_000);
  });

  const zeros = Buffer.alloc(8 * 1024 * 1024);
  it.each([
    ["gzip", () => gzipSync(zeros)],
    ["deflate", () => deflateSync(zeros)],
    ["br", () => brotliCompressSync(zeros)],
  ])("cuts a %s bomb at the decoded limit although it is small on the wire", async (encoding, compress) => {
    const payload = compress();
    expect(payload.length).toBeLessThan(100_000);
    const server = await serve((_request, socket) => {
      respond(socket, 200, { "content-type": "text/plain", "content-encoding": encoding }, payload);
    });
    const error = await rejection(publicIsLoopback(), get(url(server), { maxBytes: 10_000 }));
    expect(error).toBeInstanceOf(EgressTooLarge);
  });

  it("rejects a disallowed content type before the body is read", async () => {
    const server = await serve((_request, socket) => {
      // The body promised here is never sent: the request ends early only if the type is refused on the headers.
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 1000\r\n\r\n");
    });
    const started = Date.now();
    const error = await rejection(publicIsLoopback(), get(url(server), { acceptContentTypes: ["image/png"], timeoutMs: 5_000 }));
    expect(error).toBeInstanceOf(EgressError);
    expect(error).not.toBeInstanceOf(EgressTimeout);
    expect(error).not.toBeInstanceOf(EgressBlocked);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// Q90: the operator names the host of the AI endpoint, and the instance the AI adapter holds connects to that one origin even though
// it is on a loopback, private, CGNAT or unique-local address. Loopback stands in for the private address here. Link-local, unspecified,
// multicast and reserved addresses stay refused for it, and the instances built without the allowance (`strict`, the shared one) cannot
// reach it at all.
describe("an allowlisted AI origin", () => {
  /** The AI adapter's instance: `origin` is allowed; 127.0.0.1 also stands in for a public address. */
  const ai = (origin: string, publicIsLoopbackToo = false) =>
    new HttpEgress({
      nodeEnv: "test",
      privateOrigin: origin,
      testOnly: { dnsServers: [dns.server], ...(publicIsLoopbackToo ? { allowAddresses: ["127.0.0.1"] } : {}) },
    });

  it("reaches the origin: resolved once, pinned, with the host name in Host; the same request through an instance without the allowance is refused", async () => {
    const server = await serve(ok);
    dns.set("llm.test", ["127.0.0.1"]);
    const url = `http://llm.test:${String(server.port)}/v1/chat/completions`;
    const response = await ai(`http://llm.test:${String(server.port)}`).request(get(url));
    expect(response.status).toBe(200);
    expect(questionsFor("llm.test").sort()).toEqual(["A", "AAAA"]);
    expect(attempts()).toEqual([`127.0.0.1:${String(server.port)}`]);
    expect(server.requests[0]?.headers["host"]).toBe(`llm.test:${String(server.port)}`);

    const before = server.connections();
    expect(await rejection(strict(), get(url))).toBeInstanceOf(EgressBlocked);
    expect(server.connections()).toBe(before);
    expect(attempts()).toHaveLength(1);
  });

  it("reaches an IP-literal origin without asking the DNS", async () => {
    const server = await serve(ok);
    const origin = `http://127.0.0.1:${String(server.port)}`;
    expect((await ai(origin).request(get(`${origin}/`))).status).toBe(200);
    expect(dns.questions).toEqual([]);
  });

  it("is accepted when NODE_ENV is production, unlike the test allowances", () => {
    expect(() => new HttpEgress({ nodeEnv: "production", privateOrigin: "http://llm.lan:11434" })).not.toThrow();
    expect(() => new HttpEgress({ nodeEnv: "production", privateOrigin: "http://llm.lan:11434", testOnly: {} })).toThrow();
  });

  it("refuses the same host on another port, another scheme and another private host, without a connection", async () => {
    const allowed = await serve(ok);
    const other = await serve(ok);
    dns.set("llm.test", ["127.0.0.1"]);
    dns.set("other.test", ["127.0.0.1"]);
    const egress = ai(`http://llm.test:${String(allowed.port)}`);
    for (const url of [
      `http://llm.test:${String(other.port)}/`,
      `https://llm.test:${String(allowed.port)}/`,
      `http://other.test:${String(allowed.port)}/`,
      `http://127.0.0.1:${String(allowed.port)}/`,
    ]) {
      expect(await rejection(egress, get(url)), url).toBeInstanceOf(EgressBlocked);
    }
    expect(other.connections()).toBe(0);
    expect(allowed.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  const refused: [string, string[]][] = [
    ["link-local", ["169.254.1.1"]],
    ["the metadata address", ["169.254.169.254"]],
    ["the unspecified address", ["0.0.0.0"]],
    ["multicast", ["224.0.0.1"]],
    ["a reserved address", ["240.0.0.1"]],
    ["a documentation address", ["192.0.2.1"]],
    ["IPv6 link-local", ["fe80::1"]],
    ["the IPv6 unspecified address", ["::"]],
    ["IPv6 multicast", ["ff02::1"]],
    ["the IPv4-mapped metadata address", ["::ffff:169.254.169.254"]],
    ["the IPv4-mapped metadata address in hexadecimal", ["::ffff:a9fe:a9fe"]],
    ["a private address and the metadata address", ["127.0.0.1", "169.254.169.254"]],
    ["the metadata address and a private address", ["169.254.169.254", "127.0.0.1"]],
    ["a private address and an IPv6 link-local address", ["127.0.0.1", "fe80::1"]],
    ["a private address and a public-looking multicast address", ["127.0.0.1", "ff02::1"]],
  ];

  it.each(refused)("refuses the allowlisted name when it answers %s, without a connection", async (_label, answers) => {
    const trap = await serve(ok);
    dns.set("llm.test", answers);
    const error = await rejection(ai(`http://llm.test:${String(trap.port)}`), get(`http://llm.test:${String(trap.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(trap.connections()).toBe(0);
    expect(attempts()).toEqual([]);
  });

  it.each([["169.254.169.254"], ["169.254.1.1"], ["0.0.0.0"], ["[fe80::1]"], ["[::ffff:169.254.169.254]"]])(
    "refuses an allowlisted literal origin %s",
    async (host) => {
      const origin = `http://${host}:9`;
      expect(await rejection(ai(origin), get(`${origin}/`))).toBeInstanceOf(EgressBlocked);
      expect(attempts()).toEqual([]);
    },
  );

  it("validates the answer of every request afresh: a name that moves to another private address is followed, one that moves to the metadata address is refused", async () => {
    const [first, second] = await servePair(ok, ok);
    dns.set("moving.test", (type, ordinal) => (type === "A" ? [["127.0.0.1", "127.0.0.2", "169.254.169.254"][ordinal - 1] ?? "169.254.169.254"] : []));
    const egress = ai(`http://moving.test:${String(first.port)}`);
    const url = `http://moving.test:${String(first.port)}/`;
    expect((await egress.request(get(url))).status).toBe(200);
    expect((await egress.request(get(url))).status).toBe(200);
    expect(await rejection(egress, get(url))).toBeInstanceOf(EgressBlocked);
    expect(first.connections()).toBe(1);
    expect(second.connections()).toBe(1);
    expect(attempts()).toEqual([`127.0.0.1:${String(first.port)}`, `127.0.0.2:${String(first.port)}`]);
  });

  describe("redirects", () => {
    async function allowed(handler: Handler): Promise<{ server: LocalServer; origin: string }> {
      const server = await serve(handler);
      dns.set("llm.test", ["127.0.0.1"]);
      return { server, origin: `http://llm.test:${String(server.port)}` };
    }

    it("refuses a redirect from the origin to another private port, another private host and the metadata address, without a connection", async () => {
      const trap = await serve(ok);
      dns.set("other.test", ["127.0.0.1"]);
      for (const location of [
        `http://llm.test:${String(trap.port)}/`,
        `http://other.test:${String(trap.port)}/`,
        `http://127.0.0.1:${String(trap.port)}/`,
        "http://169.254.169.254/latest/meta-data/",
        "http://[::ffff:169.254.169.254]/",
      ]) {
        const { server, origin } = await allowed(redirect(location));
        expect(await rejection(ai(origin), get(`${origin}/`)), location).toBeInstanceOf(EgressBlocked);
        expect(server.requests).toHaveLength(1);
      }
      expect(trap.connections()).toBe(0);
      expect(attempts().filter((target) => target.startsWith("169.254."))).toEqual([]);
    });

    it("follows a redirect to the same origin on another path", async () => {
      const server = await serve((request, socket) => {
        if (request.target === "/start") {
          respond(socket, 302, { location: "/v1/models" });
        } else {
          respond(socket, 200, { "content-type": "text/plain" }, request.target);
        }
      });
      dns.set("llm.test", ["127.0.0.1"]);
      const origin = `http://llm.test:${String(server.port)}`;
      const response = await ai(origin).request(get(`${origin}/start`));
      expect(new TextDecoder().decode(response.body)).toBe("/v1/models");
      expect(server.requests.map((request) => request.target)).toEqual(["/start", "/v1/models"]);
    });

    it("follows a redirect to a public host without the Authorization header", async () => {
      const publicServer = await serve(ok);
      dns.set("pub.test", ["127.0.0.1"]);
      const { origin } = await (async () => {
        const server = await serve(redirect(`http://pub.test:${String(publicServer.port)}/answer`), "127.0.0.2");
        dns.set("llm.test", ["127.0.0.2"]);
        return { origin: `http://llm.test:${String(server.port)}` };
      })();
      const response = await ai(origin, true).request(
        get(`${origin}/`, { headers: { authorization: "Bearer provider-key-qx82", accept: "application/json", "x-api-key": "provider-key-qx83" } }),
      );
      expect(response.status).toBe(200);
      expect(publicServer.requests[0]?.headers["authorization"]).toBeUndefined();
      expect(publicServer.requests[0]?.headers["x-api-key"]).toBeUndefined();
      expect(publicServer.requests[0]?.headers["accept"]).toBe("application/json");
    });

    it("follows a redirect from a public host to the origin, which is exempt again at that hop", async () => {
      const llm = await serve(ok, "127.0.0.2");
      dns.set("llm.test", ["127.0.0.2"]);
      dns.set("pub.test", ["127.0.0.1"]);
      const hop = await serve(redirect(`http://llm.test:${String(llm.port)}/v1`));
      const response = await ai(`http://llm.test:${String(llm.port)}`, true).request(get(`http://pub.test:${String(hop.port)}/`));
      expect(response.status).toBe(200);
      expect(llm.requests).toHaveLength(1);
    });

    it.each([307, 308])("refuses a %s that would carry the body to another origin", async (status) => {
      const publicServer = await serve(ok);
      dns.set("pub.test", ["127.0.0.1"]);
      const server = await serve(redirect(`http://pub.test:${String(publicServer.port)}/`, status), "127.0.0.2");
      dns.set("llm.test", ["127.0.0.2"]);
      const origin = `http://llm.test:${String(server.port)}`;
      const error = await rejection(
        ai(origin, true),
        get(`${origin}/`, { method: "POST", body: new TextEncoder().encode("{}"), headers: { authorization: "Bearer provider-key-qx84" } }),
      );
      expect(error).toBeInstanceOf(EgressError);
      expect(publicServer.connections()).toBe(0);
    });
  });

  describe("the origin is matched as URL.origin writes it", () => {
    it("ignores case, an IPv4 notation and an IDNA name, and elides the default port", async () => {
      const server = await serve(ok);
      const port = String(server.port);
      dns.set("llm.test", ["127.0.0.1"]);
      dns.set("xn--bcher-kva.test", ["127.0.0.1"]);
      const cases: [string, string][] = [
        [`http://LLM.Test:${port}`, `http://llm.test:${port}/`],
        [`http://llm.test:${port}`, `http://LLM.TEST:${port}/`],
        [`http://0x7f.1:${port}`, `http://127.0.0.1:${port}/`],
        [`http://127.0.0.1:${port}`, `http://2130706433:${port}/`],
        [`http://bücher.test:${port}`, `http://xn--bcher-kva.test:${port}/`],
        [`http://xn--bcher-kva.test:${port}`, `http://BÜCHER.test:${port}/`],
      ];
      for (const [origin, url] of cases) {
        expect((await ai(origin).request(get(url))).status, `${origin} ${url}`).toBe(200);
      }
    });

    it("elides the default port of the scheme on both sides", async () => {
      const error = await rejection(ai("http://127.0.0.1:80"), get("http://127.0.0.1/"));
      expect(error).not.toBeInstanceOf(EgressBlocked);
      expect(attempts()).toEqual(["127.0.0.1:80"]);
      connect.mockClear();
      expect(await rejection(ai("http://127.0.0.1:81"), get("http://127.0.0.1/"))).toBeInstanceOf(EgressBlocked);
      expect(attempts()).toEqual([]);
    });

    it("does not fold a trailing dot: the host with it is another host", async () => {
      const server = await serve(ok);
      dns.set("llm.test", ["127.0.0.1"]);
      const origin = `http://llm.test:${String(server.port)}`;
      expect(await rejection(ai(origin), get(`http://llm.test.:${String(server.port)}/`))).toBeInstanceOf(EgressBlocked);
      expect(await rejection(ai(`http://llm.test.:${String(server.port)}`), get(`${origin}/`))).toBeInstanceOf(EgressBlocked);
      expect(server.connections()).toBe(0);
    });
  });

  describe("the caps hold", () => {
    async function origin(handler: Handler): Promise<string> {
      const server = await serve(handler);
      dns.set("llm.test", ["127.0.0.1"]);
      return `http://llm.test:${String(server.port)}`;
    }

    it("refuses a body over the limit", async () => {
      const base = await origin((_request, socket) => {
        respond(socket, 200, { "content-type": "application/json" }, "x".repeat(5_000));
      });
      expect(await rejection(ai(base), get(`${base}/`, { maxBytes: 1_000 }))).toBeInstanceOf(EgressTooLarge);
    });

    it("cuts a slow answer at the deadline", async () => {
      const base = await origin(() => undefined);
      const started = Date.now();
      expect(await rejection(ai(base), get(`${base}/`, { timeoutMs: 250 }))).toBeInstanceOf(EgressTimeout);
      expect(Date.now() - started).toBeLessThan(1_500);
    });

    it("refuses a content type outside the list", async () => {
      const base = await origin((_request, socket) => {
        respond(socket, 200, { "content-type": "text/html" }, "<html></html>");
      });
      const error = await rejection(ai(base), get(`${base}/`, { acceptContentTypes: ["application/json"] }));
      expect(error).toBeInstanceOf(EgressError);
      expect(error).not.toBeInstanceOf(EgressBlocked);
    });
  });
});
