import type { TestDatabase } from "@slugbase/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vacuumUntilAllVisible } from "../src/seed/vacuum.ts";

// A handle whose visibility map reads as `unmapped` (the tables `pg_class` shows with fewer all-visible pages than pages) after the
// n-th vacuum, `unmapped[n]`, and as the last entry after that.
function handle(unmapped: readonly (readonly string[])[]): { database: Pick<TestDatabase, "owner">; vacuums: () => number } {
  let vacuums = 0;
  const owner = Object.assign(
    () => Promise.resolve((unmapped[Math.min(vacuums, unmapped.length) - 1] ?? []).map((name) => ({ name }))),
    {
      unsafe: (statement: string) => {
        expect(statement).toBe("VACUUM (ANALYZE)");
        vacuums += 1;
        return Promise.resolve([]);
      },
    },
  );
  return { database: { owner: owner as unknown as TestDatabase["owner"] }, vacuums: () => vacuums };
}

describe("vacuumUntilAllVisible", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("vacuums again while a table is unmapped and stops at the first vacuum that leaves none", async () => {
    vi.useFakeTimers();
    const { database, vacuums } = handle([["bookmarks", "bookmark_tags"], ["bookmarks"], []]);
    const done = vacuumUntilAllVisible(database);
    await vi.runAllTimersAsync();
    await done;
    expect(vacuums()).toBe(3);
  });

  it("rejects with the unmapped tables named when a bounded number of vacuums does not reach it", async () => {
    vi.useFakeTimers();
    const { database, vacuums } = handle([["bookmarks", "bookmark_tags"]]);
    const done = vacuumUntilAllVisible(database);
    const rejected = expect(done).rejects.toThrow(/bookmarks, bookmark_tags .*after 20 vacuums/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(vacuums()).toBe(20);
  });
});
