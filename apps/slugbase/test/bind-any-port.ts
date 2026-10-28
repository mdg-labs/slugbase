import { Server } from "node:net";

// Preloaded into a child process with `--import` (see ephemeral-ports.ts): every listener that asks for a numeric
// port is bound to port 0 instead, so the kernel picks the port at the moment it binds it and no other process can
// take it first. The child logs the port it holds ("Listening", "Metrics listening"); the test reads it from there.
const listen = Reflect.get(Server.prototype, "listen") as (this: Server, ...args: unknown[]) => Server;

Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
  if (typeof args[0] === "number") {
    args[0] = 0;
  }
  return listen.apply(this, args);
} as typeof Server.prototype.listen;
