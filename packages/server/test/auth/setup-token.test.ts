import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ensureSetupToken, hashSetupToken, newSetupToken } from "../../src/auth/setup-token.ts";
import { recordingLogger } from "../support.ts";

describe("newSetupToken", () => {
  it("is 32 random bytes as base64url, with the SHA-256 of that text as its hash", () => {
    const token = newSetupToken();
    expect(token.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.hash.equals(createHash("sha256").update(token.value).digest())).toBe(true);
    expect(newSetupToken().value).not.toBe(token.value);
  });
});

describe("hashSetupToken", () => {
  it("ignores the whitespace a copy picks up around the token, and nothing inside it", () => {
    expect(hashSetupToken("  abc\n").equals(hashSetupToken("abc"))).toBe(true);
    expect(hashSetupToken("a bc").equals(hashSetupToken("abc"))).toBe(false);
    expect(hashSetupToken("ABC").equals(hashSetupToken("abc"))).toBe(false);
  });
});

describe("ensureSetupToken", () => {
  it("prints the token it stored and stores only its hash", async () => {
    const logger = recordingLogger();
    const stored: Buffer[] = [];
    await ensureSetupToken({
      store: {
        setSetupToken: (hash) => {
          stored.push(hash);
          return Promise.resolve(true);
        },
      },
      logger,
    });
    expect(stored).toHaveLength(1);
    expect(logger.entries).toHaveLength(1);
    const printed = logger.entries[0]?.fields["setupToken"];
    expect(typeof printed).toBe("string");
    expect(hashSetupToken(String(printed)).equals(stored[0] ?? Buffer.alloc(0))).toBe(true);
    expect(logger.entries[0]?.level).toBe("info");
  });

  it("prints nothing when setup is closed", async () => {
    const logger = recordingLogger();
    await ensureSetupToken({ store: { setSetupToken: () => Promise.resolve(false) }, logger });
    expect(logger.entries).toEqual([]);
  });

  it("logs an error without the token, and does not reject, when the database fails", async () => {
    const logger = recordingLogger();
    let offered: Buffer | undefined;
    await ensureSetupToken({
      store: {
        setSetupToken: (hash) => {
          offered = hash;
          return Promise.reject(new Error("connection string postgres://secret"));
        },
      },
      logger,
    });
    expect(offered).toBeDefined();
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe("error");
    expect(JSON.stringify(logger.entries)).not.toContain("secret");
    expect(logger.entries[0]?.fields["setupToken"]).toBeUndefined();
  });
});
