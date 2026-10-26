import { useTestDatabase } from "@slugbase/testing/db";
import { describe, expect, it } from "vitest";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace } from "./support.ts";

// The helper seeds a token with a name unique to the call, so seeds started
// together for one account do not collide on the name (doc 08 section 3.3). The
// failure scenario: two calls under Promise.all read the shared counter after
// both had incremented it, so both tokens got one name and the second seed failed
// with name_taken.

const database = useTestDatabase();

describe("seedApiToken", () => {
  it("seeds two tokens for one account started together under different ids", async () => {
    const account = await seedAccount(database());
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: account.id, role: "owner" });

    const [first, second] = await Promise.all([
      seedApiToken(database(), { accountId: account.id, workspaceId }),
      seedApiToken(database(), { accountId: account.id, workspaceId }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.value).not.toBe(second.value);
  });
});
