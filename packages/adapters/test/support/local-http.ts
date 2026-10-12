import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type TlsOptions, type TLSSocket } from "node:tls";

// A local HTTP/1.1 server over a plain or TLS socket, for the tests of the egress adapter. The HTTP
// modules of Node are importable only inside the egress folder (T6), so the tests speak the protocol
// by hand. It records every connection and every request head, and a handler writes the answer.

export interface ReceivedRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  /** The TLS server name the client sent, for a TLS server. */
  readonly servername: string | undefined;
}

export interface LocalServer {
  readonly port: number;
  /** Connections accepted so far. */
  connections(): number;
  readonly requests: ReceivedRequest[];
  close(): Promise<void>;
}

export type Handler = (request: ReceivedRequest, socket: Socket) => void;

const HEAD_END = Buffer.from("\r\n\r\n");

function parseRequest(buffer: Buffer, servername: string | undefined): ReceivedRequest | undefined {
  const headEnd = buffer.indexOf(HEAD_END);
  if (headEnd === -1) {
    return undefined;
  }
  const [requestLine = "", ...lines] = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
  const [method = "", target = ""] = requestLine.split(" ");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const length = Number(headers["content-length"] ?? "0");
  const bodyStart = headEnd + HEAD_END.length;
  if (buffer.length < bodyStart + length) {
    return undefined;
  }
  return { method, target, headers, body: buffer.subarray(bodyStart, bodyStart + length), servername };
}

export async function startLocalServer(handler: Handler, tls?: TlsOptions): Promise<LocalServer> {
  const requests: ReceivedRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  const onConnection = (socket: Socket): void => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const servername = tls === undefined ? undefined : (socket as TLSSocket).servername || undefined;
      const request = parseRequest(pending, servername);
      if (request !== undefined) {
        pending = Buffer.alloc(0);
        requests.push(request);
        handler(request, socket);
      }
    });
  };

  const server: Server = tls === undefined ? createTcpServer(onConnection) : createTlsServer(tls, onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    connections: () => connections,
    requests,
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

/** Answers with a complete response and closes the connection. */
export function respond(socket: Socket, status: number, headers: Record<string, string>, body: string | Buffer = ""): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = Object.entries({ "content-length": String(payload.length), ...headers })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${String(status)} Status\r\n${head}\r\n`), payload]));
}
