import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRILL, PROXY_DRILL, runSequence, UPGRADE_DRILL } from "./run-sequence.ts";

interface Rig {
  calls: (readonly string[])[];
  notes: string[];
  sequence: (options: { forwarded?: string[]; inImage?: boolean; statuses?: number[]; interruptAfter?: number }) => Promise<number>;
}

/** A rig whose runs end with the given statuses in order; the run count after which the interrupt arrives is optional. */
function rig(): Rig {
  const calls: (readonly string[])[] = [];
  const notes: string[] = [];
  return {
    calls,
    notes,
    sequence: ({ forwarded = [], inImage = false, statuses = [], interruptAfter }) =>
      runSequence({
        forwarded,
        inImage,
        run: (args) => {
          calls.push(args);
          return Promise.resolve(statuses[calls.length - 1] ?? 0);
        },
        interrupted: () => interruptAfter !== undefined && calls.length >= interruptAfter,
        note: (message) => notes.push(message),
      }),
  };
}

void describe("the run of the journeys and the drills", () => {
  void it("runs the journeys, the restore drill and the reverse proxy drill in that order", async () => {
    const r = rig();
    assert.equal(await r.sequence({}), 0);
    assert.deepEqual(r.calls, [[], DRILL, PROXY_DRILL]);
  });

  void it("ends with the first status that is not zero, in the order the runs were made", async () => {
    assert.equal(await rig().sequence({ statuses: [3, 4, 5] }), 3);
    assert.equal(await rig().sequence({ statuses: [0, 4, 5] }), 4);
    assert.equal(await rig().sequence({ statuses: [0, 0, 5] }), 5);
  });

  void it("does not start the reverse proxy drill when an interrupt reached the restore drill", async () => {
    const r = rig();
    assert.equal(await r.sequence({ statuses: [0, 130], interruptAfter: 2 }), 130);
    assert.deepEqual(r.calls, [[], DRILL]);
  });

  void it("keeps the status of a failed journey when the restore drill was interrupted", async () => {
    const r = rig();
    assert.equal(await r.sequence({ statuses: [1, 130], interruptAfter: 2 }), 1);
    assert.deepEqual(r.calls, [[], DRILL]);
  });

  void it("does not start the drills when an interrupt reached the journeys", async () => {
    const r = rig();
    assert.equal(await r.sequence({ statuses: [130], interruptAfter: 1 }), 130);
    assert.deepEqual(r.calls, [[]]);
  });

  void it("runs only the journeys, with the options, when there are options", async () => {
    const r = rig();
    assert.equal(await r.sequence({ forwarded: ["--grep", "x"], statuses: [2] }), 2);
    assert.deepEqual(r.calls, [["--grep", "x"]]);
  });

  void it("runs only the named drill, with the options after its name", async () => {
    const restore = rig();
    await restore.sequence({ forwarded: ["restore-drill", "--headed"] });
    assert.deepEqual(restore.calls, [[...DRILL, "--headed"]]);
    const proxy = rig();
    await proxy.sequence({ forwarded: ["reverse-proxy"] });
    assert.deepEqual(proxy.calls, [PROXY_DRILL]);
    const upgrade = rig();
    await upgrade.sequence({ forwarded: ["upgrade-drill", "--headed"], statuses: [7] });
    assert.deepEqual(upgrade.calls, [[...UPGRADE_DRILL, "--headed"]]);
  });

  void it("ends with the status of the upgrade drill, and leaves it out of a run without arguments", async () => {
    const named = rig();
    assert.equal(await named.sequence({ forwarded: ["upgrade-drill"], statuses: [7] }), 7);
    const all = rig();
    await all.sequence({});
    assert.ok(!all.calls.some((call) => call.includes(UPGRADE_DRILL[1] ?? "")), "the run without arguments does not run the upgrade drill");
  });

  void it("leaves the drills to the host in the Playwright image and says so", async () => {
    const r = rig();
    assert.equal(await r.sequence({ inImage: true, statuses: [1] }), 1);
    assert.deepEqual(r.calls, [[]]);
    assert.equal(r.notes.length, 1);
  });
});
