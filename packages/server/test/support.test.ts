import { connect, isIP } from "node:net";
import { describe, expect, it } from "vitest";
import { serverConfig } from "./support.ts";

// A test server that opens a connection to the config's database must fail at once. A host name has to be
// resolved first, and on a CI runner that lookup can take seconds to fail, which a test sees as a timeout.

function refused(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`something accepted a connection on port ${String(port)}`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? error.message);
    });
  });
}

function urlOf(value: string | undefined): URL {
  expect(value).toBeDefined();
  return new URL(value ?? "");
}

describe("the shared server test config", () => {
  const config = serverConfig();

  it.each([
    ["DATABASE_URL", config.DATABASE_URL],
    ["DATABASE_MIGRATE_URL", config.DATABASE_MIGRATE_URL],
  ])("names a loopback IP literal in %s, so no lookup precedes a connection", (_name, value) => {
    const url = urlOf(value);
    expect(isIP(url.hostname)).not.toBe(0);
    expect(["127.0.0.1", "::1", "[::1]"]).toContain(url.hostname);
  });

  it.each([
    ["DATABASE_URL", config.DATABASE_URL],
    ["DATABASE_MIGRATE_URL", config.DATABASE_MIGRATE_URL],
  ])("names a port in %s that refuses a connection at once", async (_name, value) => {
    expect(await refused(Number(urlOf(value).port))).toBe("ECONNREFUSED");
  });

  it("lets a test override both database URLs", () => {
    const overridden = serverConfig({ DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@127.0.0.1:54329/other" });
    expect(urlOf(overridden.DATABASE_URL).port).toBe("54329");
  });
});
