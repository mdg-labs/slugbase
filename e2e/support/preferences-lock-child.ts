import { appendFileSync } from "node:fs";
import { enter, leave, underMutex, type Wants } from "./preferences-lock.ts";

// A process of the multi-process tests of the lock of the account's preferences (preferences-lock.test.ts): it uses the real module, and
// writes what it does, in the order it does it, to a journal that every process appends to, so that the test can see whether two of them
// were inside together. Arguments: the mode, the lock, the journal, the rounds, and for `lock` the requests as JSON, one for each round.

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [mode, dir, journal, rounds, asked] = process.argv.slice(2);
if (mode === undefined || dir === undefined || journal === undefined || rounds === undefined) {
  throw new Error("usage: preferences-lock-child.ts <mutex|lock> <lock> <journal> <rounds> [requests]");
}
const note = (line: string): void => {
  appendFileSync(journal, `${line}\n`);
};
const WAIT_MS = 60_000;

if (mode === "mutex") {
  for (let round = 0; round < Number(rounds); round += 1) {
    await underMutex(dir, Date.now() + WAIT_MS, async () => {
      note(`in ${String(process.pid)}`);
      await pause(2);
      note(`out ${String(process.pid)}`);
    });
  }
} else {
  const requests = JSON.parse(asked ?? "[]") as Wants[];
  for (const wants of requests) {
    const id = await enter(dir, wants, {
      waitMs: WAIT_MS,
      pollMs: 5,
      apply: () => {
        note(`apply ${JSON.stringify(wants)}`);
        return Promise.resolve({ by: process.pid });
      },
    });
    note(`in ${JSON.stringify(wants)}`);
    await pause(3);
    note(`out ${JSON.stringify(wants)}`);
    await leave(
      dir,
      id,
      () => {
        note("restore");
        return Promise.resolve();
      },
      WAIT_MS,
    );
  }
}
