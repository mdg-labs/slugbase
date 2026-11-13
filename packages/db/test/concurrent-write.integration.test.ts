import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { withUncommittedWrite } from "./support/concurrent-write.ts";

// The helper that holds an uncommitted write under a call (test support, not product code). The failure scenario: a call that throws before the helper
// has seen it wait leaves the held transaction open, so its write stays locked and its connection stays occupied, and every later statement on those rows,
// and the drop of the test database, waits behind it.

const HOOK_TIMEOUT_MS = 300_000;
const LOCK_TIMEOUT = "3s";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.owner.unsafe(`
    CREATE TABLE concurrent_write_probe (id int PRIMARY KEY, note text NOT NULL);
    GRANT ALL ON concurrent_write_probe TO slugbase_system, slugbase_app;`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let nextId = 0;
function holdRow(): { id: number; write: Parameters<typeof withUncommittedWrite>[1] } {
  nextId += 1;
  const id = nextId;
  return {
    id,
    write: async (tx) => {
      await tx`INSERT INTO concurrent_write_probe (id, note) VALUES (${id}, 'held')`;
    },
  };
}

/**
 * Inserts the row under a bounded lock wait and returns what the table then holds for it: a row a transaction still holds uncommitted makes the insert
 * wait on that transaction, so it throws the lock timeout, and one that was committed is found as it was written.
 */
async function note(id: number): Promise<string | undefined> {
  return db.owner.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx`INSERT INTO concurrent_write_probe (id, note) VALUES (${id}, 'after') ON CONFLICT (id) DO NOTHING`;
    const rows = await tx<{ note: string }[]>`SELECT note FROM concurrent_write_probe WHERE id = ${id}`;
    return rows[0]?.note;
  });
}

describe("withUncommittedWrite", () => {
  it("releases the held transaction and reports the call's error when the call throws before it returns a promise", async () => {
    const held = holdRow();
    const failure = new Error("the call threw");

    await expect(
      withUncommittedWrite(db, held.write, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    // The held write is committed and no longer locked: the bounded insert completes instead of timing out on the holder, and finds the committed row.
    await expect(note(held.id)).resolves.toBe("held");
  });

  it("holds the write until the call waits on it and then returns the call's value", async () => {
    const held = holdRow();

    const rows = await withUncommittedWrite(
      db,
      held.write,
      () => db.app<{ note: string }[]>`INSERT INTO concurrent_write_probe (id, note) VALUES (${held.id}, 'clash') ON CONFLICT (id) DO UPDATE SET note = 'clash' RETURNING note`,
    );

    expect(rows.map((row) => row.note)).toEqual(["clash"]);
    await expect(note(held.id)).resolves.toBe("clash");
  });

  it("fails when the call stays pending past the deadline without waiting on the held write", async () => {
    const held = holdRow();

    // The call only returns once it finds the held write committed, which the helper does after the deadline: a helper that took the deadline for a wait would pass.
    const findsCommitted = async (): Promise<string | undefined> => {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const rows = await db.app<{ note: string }[]>`SELECT note FROM concurrent_write_probe WHERE id = ${held.id}`;
        if (rows[0] !== undefined) {
          return rows[0].note;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return undefined;
    };

    await expect(withUncommittedWrite(db, held.write, findsCommitted, { deadlineMs: 300 })).rejects.toThrow(/did not exercise the race/);

    // The held write was still released and committed.
    await expect(note(held.id)).resolves.toBe("held");
  }, 60_000);

  it("fails when the call finishes without waiting on the held write", async () => {
    const held = holdRow();

    await expect(withUncommittedWrite(db, held.write, () => Promise.resolve("done"))).rejects.toThrow(/finished without waiting/);

    await expect(note(held.id)).resolves.toBe("held");
  });
});
