import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { SecretBoxPort } from "@slugbase/core";
import { createMfaResealStore, type MfaResealStore } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { getConstructionPlans } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { secretResealJob } from "../../src/worker/jobs/secret-reseal.ts";
import { productionEnv } from "../config/support.ts";
import { testKey, testSecretBox, type TestKey } from "../secret-box.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// `secrets.reseal` (doc 01 sections 8.1 and 10): the hourly job that re-seals every second-factor secret that is still under a key other
// than the current one, so that an operator can drop ENCRYPTION_KEY_PREVIOUS. The failure it guards against: an operator removes the old
// key and every member who has not signed in since loses the second factor. The secrets are written through the system operations of
// @slugbase/db as slugbase_app, disabled accounts and pending enrolments included, with a compare-and-set on what the job read.

const database = useTestDatabase();

const BATCH = 100;

function appUrl(): string {
  const { options } = database().app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

let store: MfaResealStore;

beforeAll(async () => {
  const owner = database().owner;
  const session = await owner.reserve();
  try {
    await session.unsafe(getConstructionPlans("pgboss", { createSchema: false }));
  } finally {
    session.release();
  }
  store = createMfaResealStore({ url: appUrl(), poolSize: 2 });
}, 120_000);

afterAll(async () => {
  await store.close();
});

const started: RunningWorker[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((worker) => worker.shutdown()));
});

// The sweep reads every account, so each test starts from accounts that hold no secret.
beforeEach(async () => {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL`;
  });
});

let accountNumber = 0;

type State = "active" | "pending" | "disabled";

interface Seeded {
  readonly id: string;
  readonly plaintext: Buffer;
  readonly state: State;
}

/** An account whose secret is sealed by `sealer` under its own key (and the account's data), in the state asked for. */
async function seed(sealer: SecretBoxPort, state: State = "active"): Promise<Seeded> {
  accountNumber += 1;
  const number = accountNumber;
  const id = randomUUID();
  const plaintext = Buffer.from(`totp-secret-${String(number)}-${randomUUID()}`);
  const sealed = await sealer.seal(plaintext, mfaSecretOptions(id));
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${id}, true)`;
    await tx`
      INSERT INTO accounts (id, email, display_name, password_hash)
      VALUES (${id}, ${`reseal${String(number)}@example.test`}, 'Test account', '$argon2id$stub')`;
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET mfa_secret = ${Buffer.from(sealed.ciphertext)}, mfa_secret_key_id = ${sealed.keyId} WHERE id = ${id}`;
    if (state !== "pending") {
      await tx`UPDATE accounts SET mfa_enabled_at = now() - interval '2 days', mfa_last_step = 4242 WHERE id = ${id}`;
    }
    if (state === "disabled") {
      await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${id}`;
    }
  });
  return { id, plaintext, state };
}

interface Row {
  secret: Buffer | null;
  key_id: string | null;
  enabled_at: Date | null;
  last_step: string | null;
  disabled_at: Date | null;
}

async function row(id: string): Promise<Row> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Row[]>`
      SELECT mfa_secret AS secret, mfa_secret_key_id AS key_id, mfa_enabled_at AS enabled_at, mfa_last_step::text AS last_step, disabled_at
      FROM accounts WHERE id = ${id}`;
  });
  const found = rows[0];
  if (found === undefined) {
    throw new Error("the account is missing");
  }
  return found;
}

async function keyIdsInUse(): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ key_id: string }[]>`SELECT DISTINCT mfa_secret_key_id AS key_id FROM accounts WHERE mfa_secret IS NOT NULL ORDER BY 1`;
  });
  return rows.map((entry) => entry.key_id);
}

async function plaintextOf(box: SecretBoxPort, seeded: Seeded): Promise<Buffer> {
  const stored = await row(seeded.id);
  return Buffer.from(await box.open({ ciphertext: new Uint8Array(stored.secret ?? []), keyId: stored.key_id ?? "" }, mfaSecretOptions(seeded.id)));
}

interface Keys {
  readonly oldKey: TestKey;
  readonly newKey: TestKey;
  /** What the application holds after the rotation: the new key seals, the old one still opens. */
  readonly rotated: SecretBoxPort;
  /** What sealed the secrets before it. */
  readonly before: SecretBoxPort;
}

function keys(): Keys {
  const oldKey = testKey("k-old");
  const newKey = testKey("k-new");
  return { oldKey, newKey, rotated: testSecretBox(newKey, oldKey), before: testSecretBox(oldKey) };
}

function moduleContext(secretBox: SecretBoxPort, logger = recordingLogger()): ModuleContext {
  return { config: serverConfig(), logger, adapters: { ...adapters(), secretBox }, withTenant: (tenant, work) => fakeDatabase().withTenant(tenant, work) };
}

/** Runs the job once against the real store and returns what it logged. */
async function run(secretBox: SecretBoxPort, jobStore: Pick<MfaResealStore, "keyIds" | "secretsUnderKey" | "reseal"> = store) {
  const logger = recordingLogger();
  await secretResealJob(jobStore).handle({}, moduleContext(secretBox, logger));
  return logger;
}

function finished(logger: ReturnType<typeof recordingLogger>): Readonly<Record<string, unknown>> {
  const entry = logger.entries.find((candidate) => candidate.message === "Secret reseal finished");
  if (entry === undefined) {
    throw new Error("the job did not log that it finished");
  }
  return entry.fields;
}

describe("secrets.reseal", () => {
  it("leaves no secret under the old key, whatever the account's state and however many there are, and each still opens to what it sealed", async () => {
    const { newKey, rotated, before } = keys();
    const seeded = [
      await seed(before, "active"),
      await seed(before, "pending"),
      await seed(before, "disabled"),
      ...(await Promise.all(Array.from({ length: BATCH + 8 }, () => seed(before, "active")))),
    ];
    const current = await seed(testSecretBox(newKey), "active");
    const currentBefore = await row(current.id);
    const before2 = await Promise.all(seeded.map((entry) => row(entry.id)));
    expect(await keyIdsInUse()).toEqual(["k-new", "k-old"]);

    const logger = await run(rotated);

    expect(await keyIdsInUse()).toEqual(["k-new"]);
    for (const [index, entry] of seeded.entries()) {
      const after = await row(entry.id);
      const prior = before2[index];
      expect(after.key_id).toBe("k-new");
      expect(after.secret?.equals(prior?.secret ?? Buffer.alloc(0))).toBe(false);
      expect(await plaintextOf(rotated, entry)).toEqual(entry.plaintext);
      expect({ enabled: after.enabled_at, step: after.last_step, disabled: after.disabled_at }).toEqual({
        enabled: prior?.enabled_at,
        step: prior?.last_step,
        disabled: prior?.disabled_at,
      });
    }
    // Opens with the new key alone: the old key can go.
    expect(await plaintextOf(testSecretBox(newKey), seeded[0] ?? current)).toEqual((seeded[0] ?? current).plaintext);
    expect(await row(current.id)).toEqual(currentBefore);
    expect(finished(logger)).toMatchObject({ resealed: seeded.length, skipped: 0, unopenable: 0, remaining: {} });
  }, 120_000);

  it("reseals nothing on a second run", async () => {
    const { rotated, before } = keys();
    const seeded = await seed(before, "active");
    await run(rotated);
    const afterFirst = await row(seeded.id);

    const logger = await run(rotated);

    expect(finished(logger)).toMatchObject({ resealed: 0, skipped: 0, unopenable: 0, remaining: {} });
    expect(await row(seeded.id)).toEqual(afterFirst);
  });

  it("does nothing when every secret is under the current key, with no previous key configured", async () => {
    const { newKey } = keys();
    const only = testSecretBox(newKey);
    const seeded = await seed(only, "active");
    const stored = await row(seeded.id);

    const logger = await run(only);

    expect(finished(logger)).toMatchObject({ resealed: 0, skipped: 0, unopenable: 0, remaining: {} });
    expect(await row(seeded.id)).toEqual(stored);
  });

  it("does not overwrite a secret that changed after the job read it, nor give a secret back to an account that turned MFA off", async () => {
    const { rotated, before } = keys();
    const replaced = await seed(before, "active");
    const off = await seed(before, "active");
    const plain = await seed(before, "active");
    const resealedByMember = await rotated.reseal(
      { ciphertext: new Uint8Array((await row(replaced.id)).secret ?? []), keyId: "k-old" },
      mfaSecretOptions(replaced.id),
    );
    // What happens between the read of a page and the write of its secrets: the member signs in (the lazy re-sealing) and another turns MFA off.
    const racing: Pick<MfaResealStore, "keyIds" | "secretsUnderKey" | "reseal"> = {
      keyIds: () => store.keyIds(),
      reseal: (accountId, expected, secret) => store.reseal(accountId, expected, secret),
      secretsUnderKey: async (keyId, after, limit) => {
        const page = await store.secretsUnderKey(keyId, after, limit);
        await database().owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`UPDATE accounts SET mfa_secret = ${Buffer.from(resealedByMember.ciphertext)}, mfa_secret_key_id = ${resealedByMember.keyId} WHERE id = ${replaced.id}`;
          await tx`UPDATE accounts SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = ${off.id}`;
        });
        return page;
      },
    };

    const logger = await run(rotated, racing);

    expect(finished(logger)).toMatchObject({ resealed: 1, skipped: 2, unopenable: 0 });
    const kept = await row(replaced.id);
    expect(kept.secret?.equals(Buffer.from(resealedByMember.ciphertext))).toBe(true);
    expect(await row(off.id)).toMatchObject({ secret: null, key_id: null, enabled_at: null, last_step: null });
    expect((await row(plain.id)).key_id).toBe("k-new");
  });

  it("leaves a secret it cannot open as it is, counts it, logs only its account, and succeeds", async () => {
    const { rotated, before } = keys();
    const good = await seed(before, "active");
    const goneKey = await seed(testSecretBox(testKey("k-gone")), "active");
    // Sealed for another account's row, so its data does not match: it does not open here.
    const other = randomUUID();
    const misbound = await seed(before, "active");
    const foreign = await before.seal(Buffer.from("not-for-this-account"), mfaSecretOptions(other));
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.from(foreign.ciphertext)}, mfa_secret_key_id = ${foreign.keyId} WHERE id = ${misbound.id}`;
    });
    const goneBefore = await row(goneKey.id);
    const misboundBefore = await row(misbound.id);

    const logger = await run(rotated);

    expect(finished(logger)).toMatchObject({ resealed: 1, skipped: 0, unopenable: 2, remaining: { "k-gone": 1, "k-old": 1 } });
    expect(await row(goneKey.id)).toEqual(goneBefore);
    expect(await row(misbound.id)).toEqual(misboundBefore);
    expect((await row(good.id)).key_id).toBe("k-new");
    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings.map((entry) => entry.fields.accountId).sort()).toEqual([goneKey.id, misbound.id].sort());
  });

  it("holds no secret, ciphertext or key in anything it logs", async () => {
    const { oldKey, newKey, rotated, before } = keys();
    const seeded = await seed(before, "active");
    const unopenable = await seed(testSecretBox(testKey("k-gone")), "active");
    const stored = [await row(seeded.id), await row(unopenable.id)];

    const logger = await run(rotated);

    const logged = JSON.stringify(logger.entries);
    const after = await row(seeded.id);
    const needles = [
      seeded.plaintext,
      ...stored.map((entry) => entry.secret ?? Buffer.alloc(0)),
      after.secret ?? Buffer.alloc(0),
      oldKey.key,
      newKey.key,
    ];
    for (const needle of needles) {
      for (const text of [needle.toString("hex"), needle.toString("base64"), needle.toString("utf8")]) {
        expect(logged.includes(text)).toBe(false);
      }
    }
  });

  it("leaves every row either under the old key or under the new one when the database fails halfway, and finishes on the next run", async () => {
    const { rotated, before } = keys();
    const seeded = await Promise.all([seed(before), seed(before), seed(before), seed(before)]);
    let writes = 0;
    const failing: Pick<MfaResealStore, "keyIds" | "secretsUnderKey" | "reseal"> = {
      keyIds: () => store.keyIds(),
      secretsUnderKey: (keyId, after, limit) => store.secretsUnderKey(keyId, after, limit),
      reseal: (accountId, expected, secret) => {
        writes += 1;
        return writes === 3 ? Promise.reject(new Error("the database went away")) : store.reseal(accountId, expected, secret);
      },
    };

    await expect(run(rotated, failing)).rejects.toThrow("the database went away");

    const keyIds = await Promise.all(seeded.map(async (entry) => (await row(entry.id)).key_id));
    expect(keyIds.filter((id) => id === "k-new")).toHaveLength(2);
    expect(keyIds.filter((id) => id === "k-old")).toHaveLength(2);
    for (const entry of seeded) {
      expect(await plaintextOf(rotated, entry)).toEqual(entry.plaintext);
    }

    const logger = await run(rotated);

    expect(finished(logger)).toMatchObject({ resealed: 2, remaining: {} });
    expect(await keyIdsInUse()).toEqual(["k-new"]);
  });

  it("does nothing, and logs that, when no secret box is configured", async () => {
    const { before } = keys();
    const seeded = await seed(before, "active");
    const stored = await row(seeded.id);

    const logger = await run(adapters().secretBox);

    expect(logger.entries.map((entry) => entry.message)).toEqual(["Secret reseal skipped: no secret box is configured"]);
    expect(await row(seeded.id)).toEqual(stored);
  });
});

describe("the worker", () => {
  it("runs secrets.reseal from its queue and leaves no secret under the old key", async () => {
    const { rotated, before } = keys();
    const seeded = await Promise.all([seed(before, "active"), seed(before, "disabled"), seed(before, "pending")]);
    const logger = recordingLogger();
    const created = createWorker({
      config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl() }).config,
      adapters: { ...adapters(), secretBox: rotated },
      modules: [],
      logger,
      database: fakeDatabase(),
      pollingIntervalSeconds: 0.5,
    });
    expect(created.schedules.filter((schedule) => schedule.job === "secrets.reseal")).toEqual([
      { name: "secrets.reseal", cron: "40 * * * *", job: "secrets.reseal" },
    ]);
    const running = await created.start();
    started.push(running);
    const job = created.jobs.find((candidate) => candidate.name === "secrets.reseal");
    expect(job).toBeDefined();
    if (job === undefined) {
      return;
    }

    await running.enqueue(job, {});

    const deadline = Date.now() + 20_000;
    while (!(await keyIdsInUse()).every((id) => id === "k-new")) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for secrets.reseal to re-seal the secrets");
      }
      await sleep(100);
    }
    for (const entry of seeded) {
      expect(await plaintextOf(rotated, entry)).toEqual(entry.plaintext);
    }
  }, 60_000);
});
