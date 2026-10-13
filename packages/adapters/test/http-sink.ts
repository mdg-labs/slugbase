import { createServer, type Socket } from "node:net";
import { gunzipSync } from "node:zlib";

// A local HTTP sink for the tests of an operator-configured destination: it answers every
// request with 200 and records each body. It speaks HTTP/1.1 over a plain socket (content
// length or chunked bodies, several requests per connection) because the HTTP modules of
// Node are importable only inside the egress adapter (T6).

export interface HttpSink {
  /** A Sentry-protocol DSN that points at the sink. */
  readonly dsn: string;
  /** The decoded body of every request received, in order. */
  readonly bodies: string[];
  close(): Promise<void>;
}

const HEADER_END = Buffer.from("\r\n\r\n");

function chunkedBody(rest: Buffer): { body: Buffer; used: number } | undefined {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      return undefined;
    }
    const size = Number.parseInt(rest.subarray(offset, lineEnd).toString("latin1"), 16);
    const start = lineEnd + 2;
    if (size === 0) {
      return rest.length >= start + 2 ? { body: Buffer.concat(parts), used: start + 2 } : undefined;
    }
    if (rest.length < start + size + 2) {
      return undefined;
    }
    parts.push(rest.subarray(start, start + size));
    offset = start + size + 2;
  }
}

function takeRequest(buffer: Buffer): { body: Buffer; used: number } | undefined {
  const headEnd = buffer.indexOf(HEADER_END);
  if (headEnd === -1) {
    return undefined;
  }
  const head = buffer.subarray(0, headEnd).toString("latin1").toLowerCase();
  const bodyStart = headEnd + HEADER_END.length;
  const encoded = head.includes("content-encoding: gzip");
  let taken: { body: Buffer; used: number } | undefined;
  if (head.includes("transfer-encoding: chunked")) {
    taken = chunkedBody(buffer.subarray(bodyStart));
  } else {
    const length = Number(/content-length: (\d+)/.exec(head)?.[1] ?? "0");
    taken = buffer.length >= bodyStart + length ? { body: buffer.subarray(bodyStart, bodyStart + length), used: length } : undefined;
  }
  if (taken === undefined) {
    return undefined;
  }
  return { body: encoded ? gunzipSync(taken.body) : taken.body, used: bodyStart + taken.used };
}

export async function startHttpSink(): Promise<HttpSink> {
  const bodies: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let request = takeRequest(pending); request !== undefined; request = takeRequest(pending)) {
        bodies.push(request.body.toString("utf8"));
        pending = pending.subarray(request.used);
        socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    dsn: `http://seedpublickey@127.0.0.1:${String(port)}/1`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}
