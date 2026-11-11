import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { clearPreferencesLock, enter, leave, mayEnter, shares, underMutex, type LockState, type Wants } from "./preferences-lock.ts";

const EN: Wants = { locale: "en" };
const DE: Wants = { locale: "de" };
const LIGHT_EN: Wants = { theme: "light", locale: "en" };

function state(holders: Wants[], queue: Wants[]): LockState {
  return {
    holders: holders.map((wants, at) => ({ id: `holder-${String(at)}`, pid: process.pid, wants })),
    queue: queue.map((wants, at) => ({ id: `waiting-${String(at)}`, pid: process.pid, wants })),
    stored: null,
  };
}

void describe("which journeys hold the lock of the account's preferences together", () => {
  void it("shares between journeys that ask for the same language and set no theme", () => {
    assert.equal(shares(EN, { locale: "en" }), true);
    assert.equal(shares({}, {}), true);
  });

  void it("does not share between journeys that ask for different languages", () => {
    assert.equal(shares(EN, DE), false);
    assert.equal(shares(EN, {}), false);
  });

  void it("does not share with a journey that asks to be alone, whatever it asks for", () => {
    assert.equal(shares({ locale: "en", alone: true }, EN), false);
    assert.equal(shares(EN, { locale: "en", alone: true }), false);
    assert.equal(shares({ locale: "en", alone: true }, { locale: "en", alone: true }), false);
  });

  void it("does not share with a journey that sets the theme, not even with one that asks for the same values", () => {
    assert.equal(shares(LIGHT_EN, EN), false);
    assert.equal(shares(EN, LIGHT_EN), false);
    assert.equal(shares(LIGHT_EN, { theme: "light", locale: "en" }), false);
  });
});

void describe("who may enter the lock", () => {
  void it("lets a journey in when nobody holds it and nobody came before it", () => {
    assert.equal(mayEnter(state([], [EN]), "waiting-0"), true);
    assert.equal(mayEnter(state([], [LIGHT_EN]), "waiting-0"), true);
  });

  void it("lets a journey join the holders that share with it", () => {
    assert.equal(mayEnter(state([EN, EN], [EN]), "waiting-0"), true);
  });

  void it("keeps a journey out while a holder does not share with it", () => {
    assert.equal(mayEnter(state([EN], [DE]), "waiting-0"), false);
    assert.equal(mayEnter(state([EN], [LIGHT_EN]), "waiting-0"), false);
    assert.equal(mayEnter(state([LIGHT_EN], [EN]), "waiting-0"), false);
  });

  void it("keeps a journey that would share with the holders out while one that came before it and does not share with it waits", () => {
    // The exclusive journey is not starved by the ones that share with the holders.
    const waiting = state([EN], [LIGHT_EN, EN, EN]);
    assert.equal(mayEnter(waiting, "waiting-0"), false);
    assert.equal(mayEnter(waiting, "waiting-1"), false);
    assert.equal(mayEnter(waiting, "waiting-2"), false);
  });

  void it("keeps a journey that asks to be alone out while others hold the lock, and the ones behind it out until it is gone", () => {
    const alone: Wants = { locale: "en", alone: true };
    assert.equal(mayEnter(state([EN], [alone]), "waiting-0"), false);
    assert.equal(mayEnter(state([], [alone, EN]), "waiting-0"), true);
    assert.equal(mayEnter(state([], [alone, EN]), "waiting-1"), false);
    assert.equal(mayEnter(state([alone], [EN]), "waiting-0"), false);
  });

  void it("lets journeys that share enter together behind each other, once the holders are gone", () => {
    const waiting = state([], [EN, EN, LIGHT_EN, EN]);
    assert.equal(mayEnter(waiting, "waiting-0"), true);
    assert.equal(mayEnter(waiting, "waiting-1"), true);
    assert.equal(mayEnter(waiting, "waiting-2"), false);
    assert.equal(mayEnter(waiting, "waiting-3"), false);
  });

  void it("does not let a journey that is not waiting in", () => {
    assert.equal(mayEnter(state([], [EN]), "nobody"), false);
  });
});

/** A lock in a directory of its own, and the journal of what the journeys did to the account. */
function withLock(run: (dir: string, journal: string[]) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "slugbase-preferences-lock-"));
    try {
      const dir = join(root, "account-preferences.lock");
      clearPreferencesLock(dir);
      await run(dir, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function entering(dir: string, wants: Wants, journal: string[], name: string, waitMs = 5_000): Promise<string> {
  return enter(dir, wants, {
    waitMs,
    pollMs: 5,
    apply: () => {
      journal.push(`apply ${name}`);
      return Promise.resolve({ previous: name });
    },
  });
}

function leaving(dir: string, id: string, journal: string[], name: string): Promise<void> {
  return leave(dir, id, (stored) => {
    journal.push(`restore by ${name} with ${(stored as { previous: string }).previous}`);
    return Promise.resolve();
  });
}

/** The id of a process that has ended. */
function gonePid(): number {
  const ended = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(ended.pid > 0);
  return ended.pid;
}

/** Leaves the mutex held by the process `pid`, as a process that was stopped inside a change would. */
function heldBy(dir: string, pid: number): void {
  renameSync(`${dir}.mutex-free`, `${dir}.mutex-held.${String(pid)}.left-behind`);
}

void describe("the lock of the account's preferences after a worker was stopped", () => {
  void it(
    "does not wait for a holder whose process is gone",
    withLock(async (dir, journal) => {
      const state = { holders: [{ id: "stopped", pid: gonePid(), wants: EN }], queue: [], stored: { previous: "stopped" } };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify(state));

      const id = await entering(dir, DE, journal, "next", 500);
      await leaving(dir, id, journal, "next");

      assert.deepEqual(journal, ["apply next", "restore by next with next"]);
    }),
  );

  void it(
    "breaks the mutex that a process that is gone left",
    withLock(async (dir, journal) => {
      heldBy(dir, gonePid());

      const id = await entering(dir, EN, journal, "next", 500);
      await leaving(dir, id, journal, "next");

      assert.deepEqual(journal, ["apply next", "restore by next with next"]);
    }),
  );

  void it(
    "keeps waiting for the mutex of a process that is alive",
    withLock(async (dir, journal) => {
      heldBy(dir, process.pid);

      await assert.rejects(entering(dir, EN, journal, "next", 100), /stayed in use/);
      assert.deepEqual(journal, []);
    }),
  );

  void it(
    "leaves the token in one place only: free, or held by one process",
    withLock(async (dir) => {
      const names = (): string[] => readdirSync(dirname(dir)).filter((name) => name.startsWith(`${basename(dir)}.mutex`));
      assert.deepEqual(names(), [`${basename(dir)}.mutex-free`]);
      await underMutex(dir, Date.now() + 500, () => {
        assert.equal(names().length, 1);
        assert.match(names()[0] ?? "", /\.mutex-held\./);
      });
      assert.deepEqual(names(), [`${basename(dir)}.mutex-free`]);
    }),
  );
});

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "preferences-lock-child.ts");

/** Runs the child processes to the end; one that fails fails the test with what it wrote. */
async function runChildren(argumentsOf: (at: number) => string[], count: number): Promise<void> {
  const ended = Array.from(
    { length: count },
    (_, at) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [CHILD, ...argumentsOf(at)], { stdio: ["ignore", "ignore", "pipe"] });
        let output = "";
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`a process of the lock test ended with ${String(code)}: ${output}`));
          }
        });
      }),
  );
  await Promise.all(ended);
}

function linesOf(journal: string): string[] {
  return readFileSync(journal, "utf8").split("\n").filter((line) => line !== "");
}

const PROCESSES = 8;

void describe("the mutex of the lock of the account's preferences between processes", () => {
  const exclusive = (start: (dir: string) => void) =>
    withLock(async (dir) => {
      start(dir);
      const journal = join(dirname(dir), "journal");
      writeFileSync(journal, "");
      const rounds = 6;

      await runChildren(() => ["mutex", dir, journal, String(rounds)], PROCESSES);

      // Every change was made, and each one ended before the next began: the lines come in pairs of one process.
      const lines = linesOf(journal);
      assert.equal(lines.length, PROCESSES * rounds * 2);
      for (let at = 0; at < lines.length; at += 2) {
        const [entered, left] = [lines[at]?.split(" "), lines[at + 1]?.split(" ")];
        assert.deepEqual([entered?.[0], left?.[0]], ["in", "out"], `line ${String(at)}`);
        assert.equal(entered?.[1], left?.[1], "another process was inside the change");
      }
    });

  void it("lets one process at a time make a change, and every process make its changes", exclusive(() => undefined));

  void it(
    "does the same when several processes find the mutex left by a process that is gone",
    exclusive((dir) => {
      heldBy(dir, gonePid());
    }),
  );
});

void describe("the lock of the account's preferences between processes", () => {
  void it(
    "lets every journey through, and never lets journeys that do not share inside together",
    withLock(async (dir) => {
      const journal = join(dirname(dir), "journal");
      writeFileSync(journal, "");
      const asks: Wants[][] = [
        [EN, LIGHT_EN, EN],
        [EN, DE, { locale: "en", alone: true }],
        [LIGHT_EN, EN, EN],
        [DE, EN, LIGHT_EN],
        [EN, EN, DE],
        [{ locale: "en", alone: true }, EN, EN],
      ];

      await runChildren((at) => ["lock", dir, journal, "0", JSON.stringify(asks[at])], asks.length);

      const inside: Wants[] = [];
      let entered = 0;
      let applied = 0;
      let restored = 0;
      for (const line of linesOf(journal)) {
        const [what, wants] = [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)];
        if (what === "apply") {
          applied += 1;
          assert.equal(inside.length, 0, "the values were put in place while a journey held the lock");
        } else if (what === "restore") {
          restored += 1;
          assert.equal(inside.length, 0, "the values were put back while a journey held the lock");
        } else if (what === "in") {
          const mine = JSON.parse(wants) as Wants;
          assert.ok(
            inside.every((other) => shares(other, mine)),
            `${wants} was inside with a journey it does not share with`,
          );
          inside.push(mine);
          entered += 1;
        } else if (what === "out") {
          inside.splice(inside.findIndex((other) => JSON.stringify(other) === wants), 1);
        }
      }
      assert.equal(entered, asks.flat().length);
      assert.equal(applied, restored);
      assert.ok(applied >= 1);
    }),
  );
});

void describe("the lock of the account's preferences between journeys", () => {
  void it(
    "puts the values in place once for journeys that share and back once, when the last of them ends",
    withLock(async (dir, journal) => {
      const first = await entering(dir, EN, journal, "first");
      const second = await entering(dir, EN, journal, "second");
      const third = await entering(dir, EN, journal, "third");

      await leaving(dir, second, journal, "second");
      await leaving(dir, first, journal, "first");
      assert.deepEqual(journal, ["apply first"]);
      await leaving(dir, third, journal, "third");

      assert.deepEqual(journal, ["apply first", "restore by third with first"]);
    }),
  );

  void it(
    "keeps a journey that needs other values out until every holder has ended and the values are back",
    withLock(async (dir, journal) => {
      const holder = await entering(dir, EN, journal, "holder");
      let entered = false;
      const alone = entering(dir, LIGHT_EN, journal, "alone").then((id) => {
        entered = true;
        return id;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(entered, false, "the journey that sets the theme waits for the one that holds the language");

      await leaving(dir, holder, journal, "holder");
      const id = await alone;
      await leaving(dir, id, journal, "alone");

      assert.deepEqual(journal, ["apply holder", "restore by holder with holder", "apply alone", "restore by alone with alone"]);
    }),
  );

  void it(
    "does not let journeys that share overtake one that waits for the lock alone",
    withLock(async (dir, journal) => {
      const holder = await entering(dir, EN, journal, "holder");
      const alone = entering(dir, LIGHT_EN, journal, "alone");
      // The journeys that come after the one that waits would share with the holder, and wait for it all the same.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const late = entering(dir, EN, journal, "late");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(journal, ["apply holder"]);

      await leaving(dir, holder, journal, "holder");
      const aloneId = await alone;
      assert.deepEqual(journal.slice(-1), ["apply alone"]);
      await leaving(dir, aloneId, journal, "alone");
      await leaving(dir, await late, journal, "late");

      assert.deepEqual(journal, [
        "apply holder",
        "restore by holder with holder",
        "apply alone",
        "restore by alone with alone",
        "apply late",
        "restore by late with late",
      ]);
    }),
  );

  void it(
    "lets every journey through, one group after another, when many ask at once",
    withLock(async (dir, journal) => {
      const asks: Wants[] = [EN, LIGHT_EN, EN, DE, EN, EN, LIGHT_EN, EN, DE, EN];
      const inside: Wants[] = [];
      let overlapped = false;
      const ran = asks.map(async (wants, at) => {
        const name = `journey ${String(at)}`;
        const id = await entering(dir, wants, journal, name);
        // Journeys inside together must share; one that asks for other values is alone.
        overlapped ||= inside.some((other) => !shares(other, wants));
        inside.push(wants);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inside.splice(inside.indexOf(wants), 1);
        await leaving(dir, id, journal, name);
      });
      await Promise.all(ran);

      assert.equal(journal.filter((entry) => entry.startsWith("apply")).length, journal.filter((entry) => entry.startsWith("restore")).length);
      assert.equal(overlapped, false, "journeys that do not share never ran together");
      assert.ok(journal.filter((entry) => entry.startsWith("apply")).length < asks.length, "journeys that share put the values in place together");
    }),
  );

  void it(
    "throws when the wait runs out, and the journey that gave up does not hold the lock or block the others",
    withLock(async (dir, journal) => {
      const holder = await entering(dir, EN, journal, "holder");
      await assert.rejects(entering(dir, DE, journal, "gave up", 60), /stayed locked for 0\.06 seconds/);
      await leaving(dir, holder, journal, "holder");

      const next = await entering(dir, DE, journal, "next");
      await leaving(dir, next, journal, "next");

      assert.deepEqual(journal, ["apply holder", "restore by holder with holder", "apply next", "restore by next with next"]);
    }),
  );

  void it(
    "does not hold the lock for a journey whose values could not be put in place",
    withLock(async (dir, journal) => {
      await assert.rejects(
        enter(dir, EN, {
          waitMs: 1_000,
          pollMs: 5,
          apply: () => Promise.reject(new Error("PATCH /api/v1/me answered 500")),
        }),
        /answered 500/,
      );

      const next = await entering(dir, DE, journal, "next");
      await leaving(dir, next, journal, "next");

      assert.deepEqual(journal, ["apply next", "restore by next with next"]);
    }),
  );

  void it(
    "is free again when the restore fails",
    withLock(async (dir, journal) => {
      const id = await entering(dir, EN, journal, "first");
      await assert.rejects(
        leave(dir, id, () => Promise.reject(new Error("PATCH /api/v1/me answered 500"))),
        /answered 500/,
      );

      const next = await entering(dir, DE, journal, "next");
      await leaving(dir, next, journal, "next");

      assert.deepEqual(journal, ["apply first", "apply next", "restore by next with next"]);
    }),
  );

  void it(
    "is cleared by the global setup, which leaves the mutex free",
    withLock(async (dir, journal) => {
      await entering(dir, EN, journal, "left behind");
      assert.equal(existsSync(dir), true);
      heldBy(dir, gonePid());

      clearPreferencesLock(dir);

      assert.equal(existsSync(dir), false);
      assert.deepEqual(
        readdirSync(dirname(dir)).filter((name) => name.startsWith(basename(dir))),
        [`${basename(dir)}.mutex-free`],
      );
    }),
  );
});
