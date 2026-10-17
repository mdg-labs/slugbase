import { createServer, connect, type Server, type Socket } from "node:net";

// A relay between a client and the development Postgres that, instead of
// forwarding a client write, ends the connection: the first write containing
// the given statement text. The client then loses its connection at a known
// point, with that write in flight. By default both sockets are closed at
// once; with `terminated` the client first gets the server's termination error
// (57P01) and the sockets close 100 ms later, the way a terminated backend
// shows to a client. Only the first matching write is dropped; every other
// connection and write is forwarded, so the client can reconnect through the
// relay afterwards.

export interface Relay {
  readonly port: number;
  /** Whether a write has been dropped. */
  readonly dropped: () => boolean;
  readonly close: () => Promise<void>;
}

// The server's answer to a terminated backend, as the wire protocol carries it.
function terminationResponse(): Buffer {
  const fields = ["SFATAL", "VFATAL", "C57P01", "Mterminating connection due to administrator command"];
  const body = Buffer.concat([...fields.map((field) => Buffer.from(`${field}\0`)), Buffer.from("\0")]);
  const header = Buffer.alloc(5);
  header.write("E");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

export async function relayDroppingAt(
  upstreamUrl: URL,
  statement: string,
  options: { terminated?: boolean } = {},
): Promise<Relay> {
  const sockets = new Set<Socket>();
  let matched = false;
  const listener: Server = createServer((client) => {
    const upstream = connect({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port) });
    sockets.add(client);
    sockets.add(upstream);
    let dropping = false;
    const dropBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk: Buffer) => {
      if (dropping) {
        return;
      }
      if (!matched && chunk.includes(statement)) {
        matched = true;
        dropping = true;
        if (options.terminated === true) {
          client.write(terminationResponse());
          setTimeout(dropBoth, 100);
        } else {
          dropBoth();
        }
        return;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    client.on("error", dropBoth);
    upstream.on("error", dropBoth);
    client.on("close", dropBoth);
    upstream.on("close", dropBoth);
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as { port: number };
  return {
    port,
    dropped: () => matched,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    },
  };
}
