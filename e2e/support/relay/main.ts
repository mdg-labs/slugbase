import { connect, createServer, type Socket } from "node:net";

// The relay of e2e/compose.no-egress.yml, as the service runs it: `node main.ts`, with the shipped image's Node, from a read-only mount. It
// listens on RELAY_PORT and passes each TCP connection on, byte for byte, to the same port of RELAY_TARGET, so that the port of a server on a
// network with no route out can be published on the host. It reads nothing of what passes and keeps no state.
const port = Number(process.env.RELAY_PORT ?? "");
const target = process.env.RELAY_TARGET ?? "";
if (!Number.isInteger(port) || port <= 0 || target === "") {
  process.stderr.write("RELAY_PORT and RELAY_TARGET are required\n");
  process.exit(1);
}

function end(...sockets: Socket[]): void {
  for (const socket of sockets) {
    socket.destroy();
  }
}

createServer((client) => {
  const upstream = connect({ host: target, port });
  client.on("error", () => {
    end(client, upstream);
  });
  upstream.on("error", () => {
    end(client, upstream);
  });
  client.on("close", () => {
    end(upstream);
  });
  upstream.on("close", () => {
    end(client);
  });
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(port, "0.0.0.0", () => {
  process.stdout.write(`the relay listens on ${String(port)} and passes connections on to ${target}\n`);
});
