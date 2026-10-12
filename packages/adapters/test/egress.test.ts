import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EGRESS_MAX_REQUEST_BODY_BYTES,
  EgressBlocked,
  EgressError,
  EgressTimeout,
  EgressTooLarge,
  type EgressPort,
  type EgressRequest,
} from "@slugbase/core";
import { HttpEgress } from "../src/index.ts";
import { respond, startLocalServer, type Handler, type LocalServer } from "./support/local-http.ts";

// T6: nothing here reaches the internet. The resolver is scripted and the servers listen on loopback;
// the adapter reaches them only through the test-only allowance, or is shown not to.

const servers: LocalServer[] = [];

async function serve(handler: Handler, tls?: Parameters<typeof startLocalServer>[1]): Promise<LocalServer> {
  const server = await startLocalServer(handler, tls);
  servers.push(server);
  return server;
}

const ok: Handler = (_request, socket) => {
  respond(socket, 200, { "content-type": "text/plain" }, "hello");
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function scripted(...answers: (readonly string[])[]) {
  const calls: string[] = [];
  return {
    calls,
    resolve: (hostname: string): Promise<readonly string[]> => {
      calls.push(hostname);
      return Promise.resolve(answers[Math.min(calls.length, answers.length) - 1] ?? []);
    },
  };
}

const open = (resolve: (hostname: string) => Promise<readonly string[]>) =>
  new HttpEgress({ nodeEnv: "test", resolve, testOnly: { allowNonPublicAddresses: true } });

const get = (url: string, extra: Partial<EgressRequest> = {}): EgressRequest =>
  ({ url, timeoutMs: 2_000, maxBytes: 1_000, ...extra }) as EgressRequest;

async function rejection(port: EgressPort, request: EgressRequest): Promise<unknown> {
  return port.request(request).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("refusing non-public destinations before any socket is opened", () => {
  it("refuses a hostname that resolves to the metadata address", async () => {
    const dns = scripted(["169.254.169.254"]);
    const egress = new HttpEgress({ nodeEnv: "test", resolve: dns.resolve });
    const error = await rejection(egress, get("http://metadata.example.test/latest/meta-data/"));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual(["metadata.example.test"]);
  });

  it("refuses the IPv4-mapped loopback literal without resolving or connecting", async () => {
    const server = await serve(ok);
    const dns = scripted(["8.8.8.8"]);
    const egress = new HttpEgress({ nodeEnv: "test", resolve: dns.resolve });
    expect(await rejection(egress, get("http://[::ffff:127.0.0.1]/"))).toBeInstanceOf(EgressBlocked);
    expect(await rejection(egress, get(`http://[::ffff:127.0.0.1]:${String(server.port)}/`))).toBeInstanceOf(EgressBlocked);
    expect(await rejection(egress, get(`http://[::ffff:7f00:1]:${String(server.port)}/`))).toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual([]);
    expect(server.connections()).toBe(0);
  });

  it.each([
    ["decimal", "http://2130706433"],
    ["octal", "http://017700000001"],
    ["hexadecimal", "http://0x7f000001"],
    ["dotted octal", "http://0177.0.0.1"],
    ["dotted hexadecimal", "http://0x7f.0.0.1"],
    ["short form", "http://127.1"],
    ["loopback", "http://127.0.0.1"],
    ["IPv6 loopback", "http://[::1]"],
    ["unique-local", "http://[fd00::1]"],
    ["private", "http://10.1.2.3"],
  ])("refuses an IP literal in %s notation", async (_name, origin) => {
    const server = await serve(ok);
    const base = new URL(origin);
    base.port = String(server.port);
    const dns = scripted(["8.8.8.8"]);
    expect(await rejection(new HttpEgress({ nodeEnv: "test", resolve: dns.resolve }), get(base.href))).toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual([]);
    expect(server.connections()).toBe(0);
  });

  it("refuses a hostname when any one of its answers is non-public", async () => {
    const server = await serve(ok);
    const dns = scripted(["127.0.0.1", "8.8.8.8"]);
    const error = await rejection(new HttpEgress({ nodeEnv: "test", resolve: dns.resolve }), get(`http://mixed.example.test:${String(server.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(server.connections()).toBe(0);
  });

  it.each([
    ["no answer", [] as string[]],
    ["an answer that is not an address", ["not-an-address"]],
    ["a zone id", ["fe80::1%eth0"]],
  ])("refuses a hostname that resolves to %s", async (_name, answer) => {
    const dns = scripted(answer);
    expect(await rejection(new HttpEgress({ nodeEnv: "test", resolve: dns.resolve }), get("http://odd.example.test/"))).toBeInstanceOf(EgressBlocked);
  });

  it("refuses a name that does not resolve the way it refuses an internal one", async () => {
    const egress = new HttpEgress({
      nodeEnv: "test",
      resolve: () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND gone.example.test"), { code: "ENOTFOUND" })),
    });
    const error = await rejection(egress, get("http://gone.example.test/"));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect((error as Error).message).not.toContain("getaddrinfo");
  });

  it.each([
    "ftp://example.test/file",
    "file:///etc/passwd",
    "gopher://example.test/",
    "javascript:alert(1)",
    "http://user:secret@example.test/",
    "http://user@example.test/",
    "http://:secret@example.test/",
    "http://",
    "not a url",
    "",
  ])("refuses %j", async (url) => {
    const dns = scripted(["8.8.8.8"]);
    expect(await rejection(new HttpEgress({ nodeEnv: "test", resolve: dns.resolve }), get(url))).toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual([]);
  });

  it("never puts an address in the message of an error", async () => {
    const dns = scripted(["169.254.169.254"]);
    const blocked = (await rejection(new HttpEgress({ nodeEnv: "test", resolve: dns.resolve }), get("http://metadata.example.test/"))) as Error;
    const refused = (await rejection(
      open(scripted(["127.0.0.1"]).resolve),
      get("http://closed.example.test:1/"),
    )) as Error;
    for (const error of [blocked, refused]) {
      expect(error).toBeInstanceOf(EgressError);
      expect(error.message).not.toMatch(/169\.254|127\.0\.0\.1|:1\b/);
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/169\.254|127\.0\.0\.1/);
    }
  });
});

describe("connecting to the validated address", () => {
  it("connects to the first answer, keeps the host name in Host and resolves once", async () => {
    const server = await serve(ok);
    const dns = scripted(["127.0.0.1"], ["127.0.0.2"]);
    const response = await open(dns.resolve).request(get(`http://pinned.example.test:${String(server.port)}/a/b?c=d`));
    expect(response).toMatchObject({ status: 200, contentType: "text/plain", url: `http://pinned.example.test:${String(server.port)}/a/b?c=d` });
    expect(new TextDecoder().decode(response.body)).toBe("hello");
    expect(dns.calls).toEqual(["pinned.example.test"]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "GET", target: "/a/b?c=d" });
    expect(server.requests[0]?.headers["host"]).toBe(`pinned.example.test:${String(server.port)}`);
  });

  it("does not let a caller header replace Host or the framing headers", async () => {
    const server = await serve(ok);
    await open(scripted(["127.0.0.1"]).resolve).request(
      get(`http://real.example.test:${String(server.port)}/`, {
        headers: { Host: "evil.example.test", "Content-Length": "999", "x-extra": "1" },
      }),
    );
    expect(server.requests[0]?.headers["host"]).toBe(`real.example.test:${String(server.port)}`);
    expect(server.requests[0]?.headers["content-length"]).toBeUndefined();
    expect(server.requests[0]?.headers["x-extra"]).toBe("1");
  });

  it("tries the next validated address when the first refuses the connection", async () => {
    const server = await serve(ok);
    const dns = scripted(["::1", "127.0.0.1"]);
    const response = await open(dns.resolve).request(get(`http://both.example.test:${String(server.port)}/`));
    expect(response.status).toBe(200);
    expect(dns.calls).toHaveLength(1);
  });

  it("sends a POST body with its length and reads the answer", async () => {
    const server = await serve((_request, socket) => {
      respond(socket, 201, {}, "created");
    });
    const body = new TextEncoder().encode('{"a":1}');
    const response = await open(scripted(["127.0.0.1"]).resolve).request({
      url: `http://post.example.test:${String(server.port)}/hook`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: 2_000,
      maxBytes: 100,
    });
    expect(response.status).toBe(201);
    expect(server.requests[0]).toMatchObject({ method: "POST" });
    expect(server.requests[0]?.headers["content-length"]).toBe(String(body.length));
    expect(server.requests[0]?.body.toString()).toBe('{"a":1}');
  });

  it("sends HEAD without reading a body", async () => {
    const server = await serve((_request, socket) => {
      socket.end("HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 5000000\r\n\r\n");
    });
    const response = await open(scripted(["127.0.0.1"]).resolve).request(
      get(`http://head.example.test:${String(server.port)}/`, { method: "HEAD", maxBytes: 10 }),
    );
    expect(response).toMatchObject({ status: 200, contentType: "image/png" });
    expect(response.body).toHaveLength(0);
  });

  it("returns a redirect as a response and does not follow it", async () => {
    const target = await serve(ok);
    const server = await serve((_request, socket) => {
      respond(socket, 302, { location: `http://127.0.0.1:${String(target.port)}/` });
    });
    const response = await open(scripted(["127.0.0.1"]).resolve).request(get(`http://redir.example.test:${String(server.port)}/`));
    expect(response.status).toBe(302);
    expect(target.connections()).toBe(0);
  });
});

describe("limits", () => {
  it("refuses a response whose declared length exceeds the maximum", async () => {
    const server = await serve((_request, socket) => {
      respond(socket, 200, {}, "x".repeat(500));
    });
    const error = await rejection(open(scripted(["127.0.0.1"]).resolve), get(`http://big.example.test:${String(server.port)}/`, { maxBytes: 100 }));
    expect(error).toBeInstanceOf(EgressTooLarge);
  });

  it("accepts a response of exactly the maximum", async () => {
    const server = await serve((_request, socket) => {
      respond(socket, 200, {}, "x".repeat(100));
    });
    const response = await open(scripted(["127.0.0.1"]).resolve).request(get(`http://edge.example.test:${String(server.port)}/`, { maxBytes: 100 }));
    expect(response.body).toHaveLength(100);
  });

  it("aborts a stream that goes past the maximum without declaring a length", async () => {
    let closedByClient = false;
    const server = await serve((_request, socket) => {
      socket.write("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n");
      socket.on("close", () => {
        closedByClient = true;
      });
      const chunk = `${(1024).toString(16)}\r\n${"x".repeat(1024)}\r\n`;
      const timer = setInterval(() => {
        if (closedByClient || socket.destroyed) {
          clearInterval(timer);
          return;
        }
        socket.write(chunk);
      }, 5);
      socket.on("close", () => {
        clearInterval(timer);
      });
    });
    const error = await rejection(open(scripted(["127.0.0.1"]).resolve), get(`http://stream.example.test:${String(server.port)}/`, { maxBytes: 4_000 }));
    expect(error).toBeInstanceOf(EgressTooLarge);
    await vi.waitFor(() => {
      expect(closedByClient).toBe(true);
    });
  });

  it("times out a server that never answers", async () => {
    const server = await serve(() => undefined);
    const started = Date.now();
    const error = await rejection(open(scripted(["127.0.0.1"]).resolve), get(`http://hang.example.test:${String(server.port)}/`, { timeoutMs: 150 }));
    expect(error).toBeInstanceOf(EgressTimeout);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("times out a server that drips its answer", async () => {
    const server = await serve((_request, socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\n");
      const timer = setInterval(() => {
        if (socket.destroyed) {
          clearInterval(timer);
          return;
        }
        socket.write("x");
      }, 20);
    });
    const error = await rejection(open(scripted(["127.0.0.1"]).resolve), get(`http://drip.example.test:${String(server.port)}/`, { timeoutMs: 200 }));
    expect(error).toBeInstanceOf(EgressTimeout);
  });

  it("times out a resolver that never answers", async () => {
    const egress = new HttpEgress({ nodeEnv: "test", resolve: () => new Promise(() => undefined) });
    expect(await rejection(egress, get("http://slow-dns.example.test/", { timeoutMs: 100 }))).toBeInstanceOf(EgressTimeout);
  });

  it("refuses a request body over the limit before resolving or connecting", async () => {
    const dns = scripted(["127.0.0.1"]);
    const error = await rejection(open(dns.resolve), {
      url: "http://post.example.test/",
      method: "POST",
      body: new Uint8Array(EGRESS_MAX_REQUEST_BODY_BYTES + 1),
      timeoutMs: 1_000,
      maxBytes: 10,
    });
    expect(error).toBeInstanceOf(EgressTooLarge);
    expect(dns.calls).toEqual([]);
  });

  it.each([
    ["a zero time budget", { timeoutMs: 0 }],
    ["a negative time budget", { timeoutMs: -1 }],
    ["a time budget that is not a number", { timeoutMs: Number.NaN }],
    ["a fractional maximum", { maxBytes: 1.5 }],
    ["a negative maximum", { maxBytes: -1 }],
    ["an infinite maximum", { maxBytes: Number.POSITIVE_INFINITY }],
  ])("rejects %s", async (_name, extra) => {
    const dns = scripted(["127.0.0.1"]);
    await expect(open(dns.resolve).request(get("http://x.example.test/", extra))).rejects.toBeInstanceOf(RangeError);
    expect(dns.calls).toEqual([]);
  });
});

describe("transport failures", () => {
  it("reports a refused connection as a plain egress error", async () => {
    const closed = await serve(ok);
    const { port } = closed;
    await closed.close();
    const error = await rejection(open(scripted(["127.0.0.1"]).resolve), get(`http://down.example.test:${String(port)}/`));
    expect(error).toBeInstanceOf(EgressError);
    expect(error).not.toBeInstanceOf(EgressBlocked);
    expect(error).not.toBeInstanceOf(EgressTimeout);
    expect((error as EgressError).code).toBe("egress_failed");
  });

  it("reports a connection that closes without an answer as a plain egress error", async () => {
    const server = await serve((_request, socket) => {
      socket.destroy();
    });
    const error = await rejection(open(scripted(["127.0.0.1"]).resolve), get(`http://cut.example.test:${String(server.port)}/`));
    expect(error).toBeInstanceOf(EgressError);
    expect((error as EgressError).code).toBe("egress_failed");
  });

  it("reports a header the protocol cannot carry as a plain egress error", async () => {
    const server = await serve(ok);
    const error = await rejection(
      open(scripted(["127.0.0.1"]).resolve),
      get(`http://hdr.example.test:${String(server.port)}/`, { headers: { "x-bad": "a\r\nInjected: 1" } }),
    );
    expect(error).toBeInstanceOf(EgressError);
    expect(server.requests).toHaveLength(0);
  });
});

describe("the constructor", () => {
  it("throws for a test-only allowance when NODE_ENV is production", () => {
    expect(() => new HttpEgress({ nodeEnv: "production", testOnly: { allowNonPublicAddresses: true } })).toThrow();
    expect(() => new HttpEgress({ nodeEnv: "production", testOnly: {} })).toThrow();
  });

  it("builds without allowances in production and refuses a loopback target there", async () => {
    const egress = new HttpEgress({ nodeEnv: "production" });
    expect(egress.available).toBe(true);
    expect(await rejection(egress, get("http://127.0.0.1:9/"))).toBeInstanceOf(EgressBlocked);
  });

  it("accepts the allowances outside production", () => {
    expect(() => new HttpEgress({ nodeEnv: "test", testOnly: { allowNonPublicAddresses: true } })).not.toThrow();
  });
});

describe("TLS", () => {
  let directory: string;
  let certificate: { key: string; cert: string };

  function generate(name: string): { key: string; cert: string } {
    const keyFile = join(directory, `${name}.key`);
    const certFile = join(directory, `${name}.crt`);
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "egress-tls-"));
    certificate = generate("secure.example.test");
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("verifies the certificate against the host name and sends it as the server name", async () => {
    const server = await serve(ok, certificate);
    const egress = new HttpEgress({ nodeEnv: "test", resolve: scripted(["127.0.0.1"]).resolve, testOnly: { allowNonPublicAddresses: true, ca: certificate.cert } });
    const response = await egress.request(get(`https://secure.example.test:${String(server.port)}/`));
    expect(response.status).toBe(200);
    expect(server.requests[0]?.servername).toBe("secure.example.test");
    expect(server.requests[0]?.headers["host"]).toBe(`secure.example.test:${String(server.port)}`);
  });

  it("refuses a certificate that is not valid for the host name", async () => {
    const server = await serve(ok, certificate);
    const egress = new HttpEgress({ nodeEnv: "test", resolve: scripted(["127.0.0.1"]).resolve, testOnly: { allowNonPublicAddresses: true, ca: certificate.cert } });
    const error = await rejection(egress, get(`https://other.example.test:${String(server.port)}/`));
    expect(error).toBeInstanceOf(EgressError);
    expect(server.requests).toHaveLength(0);
  });
});
