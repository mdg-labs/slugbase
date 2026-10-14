import { BreachedDatasetError } from "@slugbase/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "./support.ts";

// What the server does when the breached-password dataset cannot be loaded (doc 02 section 2.5, Q15):
// with the check on it refuses to start, because a policy without the dataset would accept every
// listed password while the check reads as on; with the check off it does not read the dataset.

const loadBreachedPasswords = vi.hoisted(() => vi.fn<() => never>());

vi.mock("@slugbase/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@slugbase/core")>()), loadBreachedPasswords }));

afterEach(() => {
  loadBreachedPasswords.mockReset();
});

async function compose(env: Record<string, string>) {
  const { createServer } = await import("../src/create-server.ts");
  return createServer({
    config: serverConfig(env),
    adapters: adapters(),
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
}

describe("createServer and the breached-password dataset", () => {
  it("refuses to be created when the check is on and the dataset cannot be loaded", async () => {
    loadBreachedPasswords.mockImplementation(() => {
      throw new BreachedDatasetError("it cannot be read");
    });
    await expect(compose({})).rejects.toBeInstanceOf(BreachedDatasetError);
    expect(loadBreachedPasswords).toHaveBeenCalledTimes(1);
  });

  it("does not read the dataset when the operator turned the check off", async () => {
    loadBreachedPasswords.mockImplementation(() => {
      throw new BreachedDatasetError("it cannot be read");
    });
    await expect(compose({ BREACHED_PASSWORD_CHECK: "false" })).resolves.toBeDefined();
    expect(loadBreachedPasswords).not.toHaveBeenCalled();
  });
});
