import { generateApiToken } from "@slugbase/core";
import type { ApiTokenPrincipalRecord } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { createApiTokenAuthenticator } from "../../src/auth/api-tokens.ts";

const RECORD: ApiTokenPrincipalRecord = {
  tokenId: "0192f3a0-0000-7000-8000-0000000000a1",
  accountId: "0192f3a0-0000-7000-8000-0000000000b1",
  workspaceId: "0192f3a0-0000-7000-8000-0000000000c1",
  scope: "read-write",
};

function setup(answer: ApiTokenPrincipalRecord | undefined | Error) {
  const lookups: { hash: Buffer; ipPrefix: string | null }[] = [];
  const authenticator = createApiTokenAuthenticator({
    store: {
      lookupApiToken: (hash, ipPrefix) => {
        lookups.push({ hash, ipPrefix });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  });
  return { authenticator, lookups };
}

describe("the API token authenticator", () => {
  it("looks the token up by the hash of the whole token with the coarse network of the client and returns its principal", async () => {
    const { authenticator, lookups } = setup(RECORD);
    const token = generateApiToken();
    const principal = await authenticator.authenticate(`Bearer ${token.value}`, { clientIp: "198.51.100.7" });
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.hash.equals(token.hash)).toBe(true);
    expect(lookups[0]?.ipPrefix).toBe("198.51.0.0/16");
    expect(principal).toEqual({ kind: "api-token", tokenId: RECORD.tokenId, accountId: RECORD.accountId, workspaceId: RECORD.workspaceId, scope: "read-write" });
  });

  it("passes no prefix for a request without a client address, and carries the read scope", async () => {
    const { authenticator, lookups } = setup({ ...RECORD, scope: "read" });
    const principal = await authenticator.authenticate(`bearer ${generateApiToken().value}`, { clientIp: undefined });
    expect(lookups[0]?.ipPrefix).toBeNull();
    expect(principal?.scope).toBe("read");
  });

  it("answers no principal for a token the database does not know", async () => {
    const { authenticator, lookups } = setup(undefined);
    expect(await authenticator.authenticate(`Bearer ${generateApiToken().value}`, { clientIp: undefined })).toBeUndefined();
    expect(lookups).toHaveLength(1);
  });

  it("answers no principal, and asks the database nothing, for a header that is not a well-formed token", async () => {
    const { authenticator, lookups } = setup(RECORD);
    const { value } = generateApiToken();
    for (const header of [`Basic ${value}`, "Bearer", "Bearer ", "Bearer x", `Bearer ${value}x`, `Bearer ${value.slice(4)}`, `Bearer  ${value}`]) {
      expect(await authenticator.authenticate(header, { clientIp: undefined }), header).toBeUndefined();
    }
    expect(lookups).toEqual([]);
  });

  it("rejects when the database cannot answer, rather than answering no principal", async () => {
    const { authenticator } = setup(new Error("connection refused"));
    await expect(authenticator.authenticate(`Bearer ${generateApiToken().value}`, { clientIp: undefined })).rejects.toThrow("connection refused");
  });
});
