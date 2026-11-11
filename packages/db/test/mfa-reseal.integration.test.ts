import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMfaResealStore, type MfaResealStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The three system operations behind the re-encryption sweep of the sealed second-factor secrets (doc 01 sections 8.1 and 10, doc 05
// section 3.3): which key ids hold secrets, a page of the secrets under one key, and a compare-and-set write of the re-sealed value. The
// failure scenarios are a sweep that skips disabled accounts (an operator drops the old key and an account an admin re-enables later
// loses its second factor), a write that replaces a secret changed since it was read, a write that turns a pending enrolment into an
// active factor or resets the replay guard, and an account that turned MFA off being given a secret again.

const HOOK_TIMEOUT_MS = 300_000;
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$b2xkc2FsdG9sZHNhbHQ$b2xkaGFzaG9sZGhhc2hvbGRoYXNoMDEyMzQ1Njc4OQ";

let db: TestDatabase;
let store: MfaResealStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createMfaResealStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

/** What the secret box would hand over: an IV, some bytes and a tag. */
function ciphertext(): Buffer {
  return randomBytes(12 + 20 + 16);
}

interface Seeded {
  readonly id: string;
  readonly secret: Buffer;
}

let counter = 0;

interface SeedOptions {
  readonly keyId?: string | null;
  readonly state?: "active" | "pending" | "disabled" | "none";
}

/** An account with a sealed secret under `keyId`: active (enabled, a step accepted), pending, disabled (and active) or with no secret. */
async function account({ keyId = "k-old", state = "active" }: SeedOptions = {}): Promise<Seeded> {
  counter += 1;
  const id = freshId();
  const secret = ciphertext();
  await seedAccount(db, { id, email: `reseal${String(counter)}@example.test`, passwordHash: PASSWORD_HASH });
  if (state !== "none" && keyId !== null) {
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = ${secret}, mfa_secret_key_id = ${keyId} WHERE id = ${id}`);
  }
  if (state === "active" || state === "disabled") {
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_enabled_at = now() - interval '1 day', mfa_last_step = 77 WHERE id = ${id}`);
  }
  if (state === "disabled") {
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${id}`);
  }
  return { id, secret };
}

interface Row {
  secret: Buffer | null;
  key_id: string | null;
  enabled_at: Date | null;
  last_step: string | null;
  disabled_at: Date | null;
}

async function row(id: string): Promise<Row> {
  const rows = await asSystem(
    db,
    (tx) => tx<Row[]>`
      SELECT mfa_secret AS secret, mfa_secret_key_id AS key_id, mfa_enabled_at AS enabled_at, mfa_last_step::text AS last_step, disabled_at
      FROM accounts WHERE id = ${id}`,
  );
  const found = rows[0];
  if (found === undefined) {
    throw new Error("the account is missing");
  }
  return found;
}

function sealed(keyId: string): { ciphertext: Uint8Array; keyId: string } {
  return { ciphertext: new Uint8Array(ciphertext()), keyId };
}

describe("the registry", () => {
  it("lists the three sweep operations", () => {
    expect(systemOperations).toEqual(expect.arrayContaining(["sys_mfa_secret_key_ids", "sys_mfa_secrets_under_key", "sys_mfa_reseal_swept"]));
  });
});

describe("keyIds", () => {
  it("counts the secrets under each key id, pending and disabled accounts included, and ignores an account with no secret", async () => {
    await account({ keyId: "k-count-a", state: "active" });
    await account({ keyId: "k-count-a", state: "pending" });
    await account({ keyId: "k-count-a", state: "disabled" });
    await account({ keyId: "k-count-b", state: "active" });
    await account({ state: "none" });

    const found = await store.keyIds();

    expect(found.find((use) => use.keyId === "k-count-a")).toEqual({ keyId: "k-count-a", secrets: 3 });
    expect(found.find((use) => use.keyId === "k-count-b")).toEqual({ keyId: "k-count-b", secrets: 1 });
    expect(found.every((use) => use.secrets > 0 && use.keyId !== "")).toBe(true);
  });
});

describe("secretsUnderKey", () => {
  it("pages through the accounts under one key in identifier order, disabled and pending accounts included", async () => {
    const seeded = [
      await account({ keyId: "k-page", state: "active" }),
      await account({ keyId: "k-page", state: "disabled" }),
      await account({ keyId: "k-page", state: "pending" }),
      await account({ keyId: "k-page", state: "active" }),
      await account({ keyId: "k-page", state: "active" }),
    ];
    await account({ keyId: "k-page-other", state: "active" });

    const first = await store.secretsUnderKey("k-page", null, 2);
    const second = await store.secretsUnderKey("k-page", first[1]?.accountId ?? null, 2);
    const third = await store.secretsUnderKey("k-page", second[1]?.accountId ?? null, 2);
    const done = await store.secretsUnderKey("k-page", third[0]?.accountId ?? null, 2);

    expect([first.length, second.length, third.length, done.length]).toEqual([2, 2, 1, 0]);
    const all = [...first, ...second, ...third];
    expect(all.map((entry) => entry.accountId)).toEqual(seeded.map((entry) => entry.id).sort());
    for (const entry of all) {
      const original = seeded.find((candidate) => candidate.id === entry.accountId);
      expect(Buffer.from(entry.secret).equals(original?.secret ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it("returns nothing for a key id no secret is under", async () => {
    expect(await store.secretsUnderKey("k-nobody", null, 10)).toEqual([]);
  });

  it("refuses a limit outside 1 to 1000 and an empty key id", async () => {
    await expect(store.secretsUnderKey("k-page", null, 0)).rejects.toThrow();
    await expect(store.secretsUnderKey("k-page", null, 1001)).rejects.toThrow();
    await expect(store.secretsUnderKey("", null, 10)).rejects.toThrow();
  });
});

describe("reseal", () => {
  it("stores the new secret and key id for an active, a pending and a disabled account, and touches nothing else", async () => {
    for (const state of ["active", "pending", "disabled"] as const) {
      const before = await account({ keyId: "k-write", state });
      const replacement = sealed("k-new");

      expect(await store.reseal(before.id, before.secret, replacement)).toBe(true);

      const after = await row(before.id);
      expect(after.key_id).toBe("k-new");
      expect(after.secret?.equals(Buffer.from(replacement.ciphertext))).toBe(true);
      const unchanged = state === "pending" ? { enabled_at: null, last_step: null } : { last_step: "77" };
      expect(after).toMatchObject(unchanged);
      expect(after.enabled_at === null).toBe(state === "pending");
      expect(after.disabled_at === null).toBe(state !== "disabled");
    }
  });

  it("writes nothing and answers false when the stored secret is no longer the one that was read", async () => {
    const before = await account({ keyId: "k-race", state: "active" });
    const replaced = ciphertext();
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = ${replaced}, mfa_secret_key_id = 'k-race-2' WHERE id = ${before.id}`);

    expect(await store.reseal(before.id, before.secret, sealed("k-new"))).toBe(false);

    const after = await row(before.id);
    expect(after.secret?.equals(replaced)).toBe(true);
    expect(after.key_id).toBe("k-race-2");
  });

  it("does not give a secret back to an account that turned MFA off, and a second write with the old value changes nothing", async () => {
    const off = await account({ keyId: "k-off", state: "active" });
    await asSystem(
      db,
      (tx) => tx`UPDATE accounts SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = ${off.id}`,
    );
    expect(await store.reseal(off.id, off.secret, sealed("k-new"))).toBe(false);
    expect(await row(off.id)).toMatchObject({ secret: null, key_id: null, enabled_at: null });

    const once = await account({ keyId: "k-once", state: "active" });
    const first = sealed("k-new");
    expect(await store.reseal(once.id, once.secret, first)).toBe(true);
    expect(await store.reseal(once.id, once.secret, sealed("k-newer"))).toBe(false);
    expect((await row(once.id)).key_id).toBe("k-new");
  });

  it("refuses a value that is not the shape of a sealed secret, and one for an account that does not exist writes nothing", async () => {
    const target = await account({ keyId: "k-shape", state: "active" });
    await expect(store.reseal(target.id, target.secret, { ciphertext: new Uint8Array(5), keyId: "k-new" })).rejects.toThrow();
    await expect(store.reseal(target.id, new Uint8Array(5), sealed("k-new"))).rejects.toThrow();
    await expect(store.reseal(target.id, target.secret, { ciphertext: new Uint8Array(ciphertext()), keyId: "" })).rejects.toThrow();
    expect((await row(target.id)).key_id).toBe("k-shape");

    expect(await store.reseal(freshId(), ciphertext(), sealed("k-new"))).toBe(false);
  });
});

describe("the role of the application", () => {
  it("cannot read the secret columns directly; the operations are its only way to them", async () => {
    const owner = await account({ keyId: "k-direct", state: "active" });
    const attempt = await db.app
      .begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${owner.id}, true)`;
        return tx`SELECT mfa_secret FROM accounts WHERE id = ${owner.id}`;
      })
      .then(
        () => "read",
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(attempt).toBe("42501");
  });
});
