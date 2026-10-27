import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startTlsProxy } from "./tls-proxy.ts";

const SLOW = "/slow";
const NEXT = "/next";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("no port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${what}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

void describe("startTlsProxy", () => {
  const work = mkdtempSync(join(tmpdir(), "slugbase-tls-proxy-test-"));
  const keyFile = join(work, "test-fixture.key");
  const certFile = join(work, "test-fixture.crt");
  const arrived = deferred();
  const upstreamGone = deferred();
  const release = deferred();
  let upstream: Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let stopProxy: (() => Promise<void>) | undefined;
  let answerSent = false;

  before(async () => {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile],
      { stdio: "ignore" },
    );
    upstream = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.url === SLOW) {
        arrived.resolve();
        response.on("close", upstreamGone.resolve);
        void release.promise.then(() => {
          answerSent = true;
          response.end("late");
        });
        return;
      }
      response.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    upstreamPort = address.port;
    proxyPort = await freePort();
    stopProxy = await startTlsProxy({ port: proxyPort, upstream: new URL(`http://127.0.0.1:${String(upstreamPort)}`), keyFile, certFile });
  });

  after(async () => {
    release.resolve();
    await stopProxy?.();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => {
      resolve();
    }));
    rmSync(work, { recursive: true, force: true });
  });

  function get(path: string): ReturnType<typeof httpsRequest> {
    return httpsRequest({ host: "127.0.0.1", port: proxyPort, path, ca: readFileSync(certFile), agent: false });
  }

  void it("aborts the upstream request and keeps serving when the client leaves before the upstream answers", async () => {
    const aborted = get(SLOW);
    aborted.on("error", () => undefined);
    aborted.end();
    await within(arrived.promise, "the upstream to receive the request");
    aborted.destroy();

    await within(upstreamGone.promise, "the proxy to abort the upstream request");
    assert.equal(answerSent, false, "the upstream request was aborted before it answered");

    release.resolve();
    // Give the late answer time to reach the proxy, which must discard it.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const body = await within(
      new Promise<string>((resolve, reject) => {
        const next = get(NEXT);
        next.on("error", reject);
        next.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
        });
        next.end();
      }),
      "the proxy to answer the next request",
    );
    assert.equal(body, "ok");
  });

  void it("keeps an idle connection open past Node's default keep-alive timeout, so a client can reuse it", async () => {
    const socket = tlsConnect({ host: "127.0.0.1", port: proxyPort, ca: readFileSync(certFile) });
    let received = "";
    let closed = false;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closed = true;
    });
    const requestOverSocket = async (): Promise<string> => {
      received = "";
      socket.write(`GET ${NEXT} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
      const deadline = Date.now() + 5000;
      while (!received.endsWith("\r\n\r\nok")) {
        if (closed || Date.now() > deadline) {
          throw new Error(`no complete answer; connection closed: ${String(closed)}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      return received;
    };
    try {
      await within(new Promise<void>((resolve) => socket.once("secureConnect", resolve)), "the TLS handshake");
      assert.match(await requestOverSocket(), /^HTTP\/1\.1 200/);

      // Node closes an idle connection after keepAliveTimeout (5 s by default) plus a 1 s buffer; wait just past that.
      await new Promise<void>((resolve) => setTimeout(resolve, 6500));
      assert.equal(closed, false, "the proxy closed an idle connection a client may still reuse");
      assert.match(await requestOverSocket(), /^HTTP\/1\.1 200/);
    } finally {
      socket.destroy();
    }
  });
});
