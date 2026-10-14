import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
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
});

const redirect =
  (location: string, status = 302): Handler =>
  (_request, socket) => {
    respond(socket, status, { location });
  };

// Hosts resolve to loopback and loopback is let through; every other address is still checked.
const loopbackOnly = (resolve: (hostname: string) => Promise<readonly string[]>) =>
  new HttpEgress({ nodeEnv: "test", resolve, testOnly: { allowAddresses: ["127.0.0.1"] } });

describe("following redirects", () => {
  it("refuses a 302 to the metadata address at the second hop and attempts no connection to it (T6)", async () => {
    const connect = vi.spyOn(Socket.prototype, "connect");
    const origin = await serve(redirect("http://169.254.169.254/latest/meta-data/"));
    const dns = scripted(["127.0.0.1"]);
    const error = await rejection(loopbackOnly(dns.resolve), get(`http://evil.example.test:${String(origin.port)}/favicon.ico`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(origin.requests).toHaveLength(1);
    expect(dns.calls).toEqual(["evil.example.test"]);
    const attempted = JSON.stringify(connect.mock.calls);
    expect(attempted).toContain(String(origin.port));
    expect(attempted).not.toContain("169.254.169.254");
    connect.mockRestore();
  });

  it("resolves each hop afresh and refuses a host name that now answers with a private address", async () => {
    const target = await serve(ok);
    const origin = await serve(redirect(`http://rebound.example.test:${String(target.port)}/`));
    const dns = scripted(["127.0.0.1"], ["10.0.0.5"]);
    const error = await rejection(loopbackOnly(dns.resolve), get(`http://first.example.test:${String(origin.port)}/`));
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual(["first.example.test", "rebound.example.test"]);
    expect(target.connections()).toBe(0);
  });

  it("resolves the same host name again for a hop back to it", async () => {
    const origin = await serve((request, socket) => {
      if (request.target === "/start") {
        respond(socket, 301, { location: "/next" });
      } else {
        respond(socket, 200, { "content-type": "text/plain" }, "arrived");
      }
    });
    const dns = scripted(["127.0.0.1"], ["127.0.0.1"]);
    const response = await loopbackOnly(dns.resolve).request(get(`http://same.example.test:${String(origin.port)}/start`));
    expect(new TextDecoder().decode(response.body)).toBe("arrived");
    expect(dns.calls).toEqual(["same.example.test", "same.example.test"]);
    expect(response.url).toBe(`http://same.example.test:${String(origin.port)}/next`);
  });

  it("follows a redirect to another host and connects to the address validated for that host", async () => {
    const target = await serve(ok);
    const origin = await serve(redirect(`http://other.example.test:${String(target.port)}/page`, 308));
    const dns = scripted(["127.0.0.1"], ["127.0.0.1"]);
    const response = await loopbackOnly(dns.resolve).request(get(`http://one.example.test:${String(origin.port)}/`));
    expect(response).toMatchObject({ status: 200, url: `http://other.example.test:${String(target.port)}/page` });
    expect(target.requests[0]?.headers["host"]).toBe(`other.example.test:${String(target.port)}`);
    expect(dns.calls).toEqual(["one.example.test", "other.example.test"]);
  });

  it.each([
    ["ftp", "ftp://example.test/file"],
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["gopher", "gopher://example.test/"],
    ["a URL with credentials", "http://user:secret@example.test/"],
    ["a loopback literal", "http://127.0.0.2:1/"],
    ["a mapped loopback literal", "http://[::ffff:127.0.0.2]/"],
    ["a loopback in decimal notation", "http://2130706434/"],
  ])("refuses a redirect to %s", async (_name, location) => {
    const origin = await serve(redirect(location));
    const dns = scripted(["127.0.0.1"], ["8.8.8.8"]);
    const error = await rejection(
      new HttpEgress({ nodeEnv: "test", resolve: dns.resolve, testOnly: { allowAddresses: ["127.0.0.1"] } }),
      get(`http://origin.example.test:${String(origin.port)}/`),
    );
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual(["origin.example.test"]);
  });

  it("refuses a redirect to a loop, to itself and to the first URL", async () => {
    const origin = await serve((request, socket) => {
      const next = { "/a": "/b", "/b": "/a#again", "/self": "/self" }[request.target] ?? "/";
      respond(socket, 302, { location: next });
    });
    const dns = scripted(["127.0.0.1"]);
    for (const path of ["/a", "/self"]) {
      const error = await rejection(loopbackOnly(dns.resolve), get(`http://loop.example.test:${String(origin.port)}${path}`));
      expect(error).toBeInstanceOf(EgressError);
      expect(error).not.toBeInstanceOf(EgressBlocked);
      expect((error as EgressError).code).toBe("egress_failed");
    }
    expect(origin.requests.map((request) => request.target)).toEqual(["/a", "/b", "/self"]);
  });

  it("follows five redirects and refuses a sixth", async () => {
    const chain = (length: number): Handler => (request, socket) => {
      const index = Number(request.target.slice(1));
      if (index < length) {
        respond(socket, 302, { location: `/${String(index + 1)}` });
      } else {
        respond(socket, 200, { "content-type": "text/plain" }, "end");
      }
    };
    const dns = scripted(["127.0.0.1"]);
    const five = await serve(chain(5));
    const response = await loopbackOnly(dns.resolve).request(get(`http://chain.example.test:${String(five.port)}/0`));
    expect(response.url).toBe(`http://chain.example.test:${String(five.port)}/5`);
    const six = await serve(chain(6));
    const error = await rejection(loopbackOnly(dns.resolve), get(`http://chain.example.test:${String(six.port)}/0`));
    expect(error).toBeInstanceOf(EgressError);
    expect((error as EgressError).code).toBe("egress_failed");
    expect(six.requests).toHaveLength(6);
  });

  it("resolves a relative Location against the URL that answered", async () => {
    const origin = await serve((request, socket) => {
      const next: Record<string, string> = { "/dir/start?q=1": "next", "/dir/next": "/abs?x=2", "/abs?x=2": "../up#frag" };
      const location = next[request.target];
      if (location === undefined) {
        respond(socket, 200, { "content-type": "text/plain" }, request.target);
      } else {
        respond(socket, 302, { location });
      }
    });
    const dns = scripted(["127.0.0.1"]);
    const response = await loopbackOnly(dns.resolve).request(get(`http://rel.example.test:${String(origin.port)}/dir/start?q=1`));
    expect(origin.requests.map((request) => request.target)).toEqual(["/dir/start?q=1", "/dir/next", "/abs?x=2", "/up"]);
    expect(response.url).toBe(`http://rel.example.test:${String(origin.port)}/up#frag`);
  });

  it("does not read the body of a redirect", async () => {
    const origin = await serve((request, socket) => {
      if (request.target === "/") {
        socket.write("HTTP/1.1 302 Found\r\nlocation: /done\r\ncontent-length: 1000000\r\n\r\npartial");
      } else {
        respond(socket, 200, { "content-type": "text/plain" }, "done");
      }
    });
    const response = await loopbackOnly(scripted(["127.0.0.1"]).resolve).request(
      get(`http://body.example.test:${String(origin.port)}/`, { maxBytes: 10 }),
    );
    expect(new TextDecoder().decode(response.body)).toBe("done");
  });

  it("returns a redirect without a Location as the response", async () => {
    const origin = await serve((_request, socket) => {
      respond(socket, 302, { "content-type": "text/plain" }, "no place to go");
    });
    const response = await loopbackOnly(scripted(["127.0.0.1"]).resolve).request(get(`http://nowhere.example.test:${String(origin.port)}/`));
    expect(response.status).toBe(302);
  });

  it("changes POST to GET without a body for 301, 302 and 303 and keeps both for 307 and 308", async () => {
    const seen: { method: string; body: string; type: string | undefined }[] = [];
    const origin = await serve((request, socket) => {
      if (/^\/3\d\d$/.test(request.target)) {
        respond(socket, Number(request.target.slice(1)), { location: "/final" });
        return;
      }
      seen.push({ method: request.method, body: request.body.toString(), type: request.headers["content-type"] });
      respond(socket, 200, {}, "");
    });
    const dns = scripted(["127.0.0.1"]);
    for (const status of [301, 302, 303, 307, 308]) {
      await loopbackOnly(dns.resolve).request({
        url: `http://post.example.test:${String(origin.port)}/${String(status)}`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode("{}"),
        timeoutMs: 2_000,
        maxBytes: 100,
      });
    }
    expect(seen).toEqual([
      { method: "GET", body: "", type: undefined },
      { method: "GET", body: "", type: undefined },
      { method: "GET", body: "", type: undefined },
      { method: "POST", body: "{}", type: "application/json" },
      { method: "POST", body: "{}", type: "application/json" },
    ]);
  });

  it("keeps caller headers on a redirect within the origin and forwards only a named few to another origin", async () => {
    const other = await serve(ok);
    const origin = await serve((request, socket) => {
      if (request.target === "/same") {
        respond(socket, 302, { location: "/landing" });
      } else if (request.target === "/cross") {
        respond(socket, 302, { location: `http://other.example.test:${String(other.port)}/landing` });
      } else {
        respond(socket, 200, {}, "");
      }
    });
    const dns = scripted(["127.0.0.1"]);
    const headers = {
      authorization: "Bearer <your API token>",
      cookie: "a=b",
      "x-api-key": "<your API key>",
      "x-extra": "1",
      accept: "text/html",
      "Accept-Language": "de",
      "user-agent": "slugbase-test",
    };
    await loopbackOnly(dns.resolve).request(get(`http://origin.example.test:${String(origin.port)}/same`, { headers }));
    await loopbackOnly(dns.resolve).request(get(`http://origin.example.test:${String(origin.port)}/cross`, { headers }));
    const landed = origin.requests.find((request) => request.target === "/landing");
    expect(landed?.headers["authorization"]).toBe("Bearer <your API token>");
    expect(landed?.headers["x-api-key"]).toBe("<your API key>");
    expect(landed?.headers["x-extra"]).toBe("1");
    const forwarded = other.requests[0]?.headers ?? {};
    expect(forwarded["authorization"]).toBeUndefined();
    expect(forwarded["cookie"]).toBeUndefined();
    expect(forwarded["x-api-key"]).toBeUndefined();
    expect(forwarded["x-extra"]).toBeUndefined();
    expect(forwarded["accept"]).toBe("text/html");
    expect(forwarded["accept-language"]).toBe("de");
    expect(forwarded["user-agent"]).toBe("slugbase-test");
  });

  it.each([307, 308])("refuses a %i to another origin for a request that carries a body, and sends it nothing", async (status) => {
    const other = await serve(ok);
    const origin = await serve(redirect(`http://other.example.test:${String(other.port)}/landing`, status));
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      {
        url: `http://origin.example.test:${String(origin.port)}/`,
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "<your API key>" },
        body: new TextEncoder().encode('{"prompt":"private"}'),
        timeoutMs: 2_000,
        maxBytes: 100,
      },
    );
    expect(error).toBeInstanceOf(EgressError);
    expect(other.connections()).toBe(0);
    expect(other.requests).toHaveLength(0);
  });

  it("keeps the body and the headers of a 307 within the origin", async () => {
    const origin = await serve((request, socket) => {
      if (request.target === "/start") {
        respond(socket, 307, { location: "/landing" });
      } else {
        respond(socket, 200, {}, "");
      }
    });
    await loopbackOnly(scripted(["127.0.0.1"]).resolve).request({
      url: `http://origin.example.test:${String(origin.port)}/start`,
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "<your API key>" },
      body: new TextEncoder().encode("{}"),
      timeoutMs: 2_000,
      maxBytes: 100,
    });
    const landed = origin.requests.find((request) => request.target === "/landing");
    expect(landed?.body.toString()).toBe("{}");
    expect(landed?.headers["x-api-key"]).toBe("<your API key>");
  });

  it("delivers no body and no key header to another origin after a 303 turns a POST into a GET", async () => {
    const other = await serve(ok);
    const origin = await serve(redirect(`http://other.example.test:${String(other.port)}/landing`, 303));
    await loopbackOnly(scripted(["127.0.0.1"]).resolve).request({
      url: `http://origin.example.test:${String(origin.port)}/`,
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "<your API key>" },
      body: new TextEncoder().encode('{"prompt":"private"}'),
      timeoutMs: 2_000,
      maxBytes: 100,
    });
    expect(other.requests[0]?.method).toBe("GET");
    expect(other.requests[0]?.body.toString()).toBe("");
    expect(other.requests[0]?.headers["x-api-key"]).toBeUndefined();
    expect(other.requests[0]?.headers["content-type"]).toBeUndefined();
  });

  it("spends one time budget across the hops", async () => {
    const origin = await serve((request, socket) => {
      const index = Number(request.target.slice(1));
      setTimeout(() => {
        respond(socket, 302, { location: `/${String(index + 1)}` });
      }, 100);
    });
    const started = Date.now();
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      get(`http://slowhops.example.test:${String(origin.port)}/0`, { timeoutMs: 350 }),
    );
    expect(error).toBeInstanceOf(EgressTimeout);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(origin.requests.length).toBeGreaterThan(1);
    expect(origin.requests.length).toBeLessThan(5);
  });
});

describe("the content-type allowlist", () => {
  const typed = (type: string | undefined, body = "payload"): Handler => (_request, socket) => {
    respond(socket, 200, type === undefined ? {} : { "content-type": type }, body);
  };
  const accepting = (...types: string[]) => ({ acceptContentTypes: types });

  it("accepts a listed type whatever its case and parameters", async () => {
    const origin = await serve(typed("Image/PNG; charset=binary"));
    const response = await loopbackOnly(scripted(["127.0.0.1"]).resolve).request(
      get(`http://ct.example.test:${String(origin.port)}/`, accepting("image/x-icon", "IMAGE/png")),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ["an unlisted type", "text/html"],
    ["a type that only starts like a listed one", "image/png2"],
    ["no type", undefined],
  ])("refuses %s after the headers, before the body is read", async (_name, type) => {
    const origin = await serve((_request, socket) => {
      // The headers promise a body that is never sent: the request ends only if it is refused on the headers.
      socket.write(`HTTP/1.1 200 OK\r\n${type === undefined ? "" : `content-type: ${type}\r\n`}content-length: 1000\r\n\r\n`);
    });
    const started = Date.now();
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      get(`http://ct.example.test:${String(origin.port)}/`, { ...accepting("image/png"), timeoutMs: 5_000 }),
    );
    expect(error).toBeInstanceOf(EgressError);
    expect(error).not.toBeInstanceOf(EgressTimeout);
    expect((error as EgressError).code).toBe("egress_failed");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses every response when the list is empty and checks nothing when there is none", async () => {
    const origin = await serve(typed("text/html"));
    const dns = scripted(["127.0.0.1"]);
    expect(await rejection(loopbackOnly(dns.resolve), get(`http://ct.example.test:${String(origin.port)}/`, accepting()))).toBeInstanceOf(EgressError);
    expect((await loopbackOnly(dns.resolve).request(get(`http://ct.example.test:${String(origin.port)}/`))).status).toBe(200);
  });

  it("checks the type of the response after the redirects, not of the redirect", async () => {
    const png = await serve(typed("image/png"));
    const html = await serve(typed("text/html"));
    const redirecting = (target: LocalServer): Handler => (_request, socket) => {
      respond(socket, 302, { location: `http://t.example.test:${String(target.port)}/`, "content-type": "text/html" });
    };
    const dns = scripted(["127.0.0.1"]);
    const toPng = await serve(redirecting(png));
    const toHtml = await serve(redirecting(html));
    expect((await loopbackOnly(dns.resolve).request(get(`http://r.example.test:${String(toPng.port)}/`, accepting("image/png")))).status).toBe(200);
    expect(await rejection(loopbackOnly(dns.resolve), get(`http://r.example.test:${String(toHtml.port)}/`, accepting("image/png")))).toBeInstanceOf(
      EgressError,
    );
  });

  it("applies to a HEAD response", async () => {
    const origin = await serve((_request, socket) => {
      socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 5\r\n\r\n");
    });
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      get(`http://ct.example.test:${String(origin.port)}/`, { method: "HEAD", ...accepting("image/png") }),
    );
    expect(error).toBeInstanceOf(EgressError);
  });
});

describe("the size cap on the decoded body", () => {
  const encoded = (encoding: string, body: Buffer): Handler => (_request, socket) => {
    respond(socket, 200, { "content-encoding": encoding, "content-type": "text/plain" }, body);
  };
  const zeros = Buffer.alloc(8 * 1024 * 1024);
  const bombs: [string, () => Buffer][] = [
    ["gzip", () => gzipSync(zeros)],
    ["deflate", () => deflateSync(zeros)],
    ["br", () => brotliCompressSync(zeros)],
  ];

  it.each(bombs)("cuts a %s bomb at the cap although its encoded size is small", async (encoding, compress) => {
    const payload = compress();
    expect(payload.length).toBeLessThan(100_000);
    const origin = await serve(encoded(encoding, payload));
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      get(`http://bomb.example.test:${String(origin.port)}/`, { maxBytes: 10_000 }),
    );
    expect(error).toBeInstanceOf(EgressTooLarge);
  });

  it.each(bombs)("returns a %s body decoded when it fits the cap", async (encoding) => {
    const compress = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[encoding as "gzip"];
    const origin = await serve(encoded(encoding, compress(Buffer.from("x".repeat(5_000)))));
    const response = await loopbackOnly(scripted(["127.0.0.1"]).resolve).request(
      get(`http://ok.example.test:${String(origin.port)}/`, { maxBytes: 5_000 }),
    );
    expect(new TextDecoder().decode(response.body)).toBe("x".repeat(5_000));
    expect(origin.requests[0]?.headers["accept-encoding"]).toBe("gzip, deflate, br");
  });

  it("cuts a body that is encoded twice at the cap", async () => {
    const origin = await serve(encoded("gzip, gzip", gzipSync(gzipSync(zeros))));
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      get(`http://bomb.example.test:${String(origin.port)}/`, { maxBytes: 10_000 }),
    );
    expect(error).toBeInstanceOf(EgressTooLarge);
  });

  it("does not let the caller choose the encodings it accepts", async () => {
    const origin = await serve(ok);
    await loopbackOnly(scripted(["127.0.0.1"]).resolve).request(
      get(`http://enc.example.test:${String(origin.port)}/`, { headers: { "Accept-Encoding": "zstd" } }),
    );
    expect(origin.requests[0]?.headers["accept-encoding"]).toBe("gzip, deflate, br");
  });

  it("refuses an encoding it cannot decode and an encoded body that is not valid", async () => {
    const dns = scripted(["127.0.0.1"]);
    const unknown = await serve(encoded("zstd", Buffer.from("not decodable")));
    const broken = await serve(encoded("gzip", Buffer.from("not gzip data")));
    const many = await serve(encoded("gzip, gzip, gzip, gzip", gzipSync(Buffer.from("x"))));
    for (const server of [unknown, broken, many]) {
      const error = await rejection(loopbackOnly(dns.resolve), get(`http://bad.example.test:${String(server.port)}/`));
      expect(error).toBeInstanceOf(EgressError);
      expect(error).not.toBeInstanceOf(EgressTooLarge);
    }
  });

  it("accepts an identity encoding and an empty encoded body", async () => {
    const dns = scripted(["127.0.0.1"]);
    const identity = await serve(encoded("identity", Buffer.from("plain")));
    const empty = await serve(encoded("gzip", Buffer.alloc(0)));
    expect(new TextDecoder().decode((await loopbackOnly(dns.resolve).request(get(`http://a.example.test:${String(identity.port)}/`))).body)).toBe("plain");
    expect((await loopbackOnly(dns.resolve).request(get(`http://b.example.test:${String(empty.port)}/`))).body).toHaveLength(0);
  });

  it("times out an encoded body that trickles in", async () => {
    const payload = gzipSync(Buffer.from("x".repeat(2_000)));
    const origin = await serve((_request, socket) => {
      socket.write(`HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: ${String(payload.length)}\r\n\r\n`);
      let sent = 0;
      const timer = setInterval(() => {
        if (socket.destroyed || sent >= payload.length - 1) {
          clearInterval(timer);
          return;
        }
        socket.write(payload.subarray(sent, sent + 1));
        sent += 1;
      }, 20);
    });
    const error = await rejection(
      loopbackOnly(scripted(["127.0.0.1"]).resolve),
      get(`http://trickle.example.test:${String(origin.port)}/`, { timeoutMs: 250 }),
    );
    expect(error).toBeInstanceOf(EgressTimeout);
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
