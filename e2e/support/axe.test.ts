import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "@playwright/test";
import { settleAnimations, settleLayout, type LayoutSettle } from "./axe.ts";

interface FakeAnimation {
  readonly playState: AnimationPlayState;
  readonly effect: { getComputedTiming: () => { iterations: number } };
  readonly finished: Promise<void>;
}

/** A fake animation that, like a real one, is "finished" once its finished promise has settled. */
function animation(playState: AnimationPlayState, iterations: number, finished: Promise<void>): FakeAnimation {
  let ended = false;
  void finished.then(() => {
    ended = true;
  });
  return {
    get playState() {
      return ended ? "finished" : playState;
    },
    effect: { getComputedTiming: () => ({ iterations }) },
    finished,
  };
}

const NEVER = new Promise<void>(() => undefined);

/**
 * A page whose evaluate runs the callback here, against a document that holds the given animations, or the ones
 * `animations` gives once the given number of frames has passed.
 */
function pageWith(animations: readonly FakeAnimation[] | ((frames: number) => readonly FakeAnimation[])): Page {
  let frames = 0;
  const current = typeof animations === "function" ? animations : () => animations;
  Object.defineProperty(globalThis, "document", { value: { getAnimations: () => current(frames) }, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: () => void) =>
      setTimeout(() => {
        frames += 1;
        callback();
      }, 1),
    configurable: true,
  });
  return { evaluate: (callback: () => Promise<void>) => callback() } as unknown as Page;
}

function within<T>(promise: Promise<T>, what: string, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${what} did not settle within ${String(ms)} ms`));
      }, ms).unref();
    }),
  ]);
}

void describe("settling the animations before a scan", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });

  void it("waits for a running animation that ends", async () => {
    let ended = false;
    const finished = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
      ended = true;
    });
    await within(settleAnimations(pageWith([animation("running", 1, finished)])), "a running animation");
    assert.equal(ended, true);
  });

  void it("waits for a transition that starts a frame later, as a dialog's does once its starting style is removed", async () => {
    let ended = false;
    const fadeIn = animation(
      "running",
      1,
      new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
        ended = true;
      }),
    );
    await within(settleAnimations(pageWith((frames) => (frames >= 1 && !ended ? [fadeIn] : []))), "a transition that starts late");
    assert.equal(ended, true);
  });

  void it("leaves an animation that never ends alone", async () => {
    await within(settleAnimations(pageWith([animation("running", Infinity, NEVER)])), "an infinite animation");
  });

  void it("leaves a paused or idle animation alone, whose finished promise waits for it to play again", async () => {
    await within(
      settleAnimations(pageWith([animation("paused", 1, NEVER), animation("idle", 1, NEVER)])),
      "a paused or idle animation",
    );
  });
});

interface LayoutProbe {
  readonly page: Page;
  /** How many frames have passed since the page was made. */
  frames: () => number;
}

/**
 * A page whose evaluate runs the callback here with the argument it is given, against a document with one target
 * whose box is the one `boxAt` gives for the number of frames that have passed, and fonts that are ready once
 * `fontsReady` settles. It holds no animation, so `settleAnimations` has nothing to wait for.
 */
function layoutPage(boxAt: (frames: number) => readonly [number, number, number, number], fontsReady: Promise<void> = Promise.resolve()): LayoutProbe {
  let frames = 0;
  const target = {
    getBoundingClientRect: () => {
      const [left, top, width, height] = boxAt(frames);
      return { left, top, width, height };
    },
  };
  Object.defineProperty(globalThis, "document", {
    value: { getAnimations: () => [], querySelectorAll: () => [target], fonts: { ready: fontsReady } },
    configurable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: () => void) =>
      setTimeout(() => {
        frames += 1;
        callback();
      }, 1),
    configurable: true,
  });
  return {
    page: { evaluate: (callback: (arg?: LayoutSettle) => Promise<void>, arg?: LayoutSettle) => callback(arg) } as unknown as Page,
    frames: () => frames,
  };
}

const SETTLE: LayoutSettle = { selector: "a", stableFrames: 3, timeoutMs: 1000 };

// The nav link of the settings pages is 206 by 30 once the page has settled; the box that a page still making room for
// its sidebar gives for the frames before is another one.
const MOVING_UNTIL = 6;
const settling = (frames: number): readonly [number, number, number, number] =>
  frames >= MOVING_UNTIL ? [280, 100, 206, 30] : [280 - 8 * (MOVING_UNTIL - frames), 100, 206, 30];

void describe("settling the layout before a scan", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });

  void it("is not done by settling the animations: there are none, and the boxes are still moving", async () => {
    const probe = layoutPage(settling);
    await within(settleAnimations(probe.page), "the animations");
    assert.ok(probe.frames() < MOVING_UNTIL, `the animations settled after ${String(probe.frames())} frames, before the boxes stopped at ${String(MOVING_UNTIL)}`);
  });

  void it("waits until the boxes of the targets have stopped moving", async () => {
    const probe = layoutPage(settling);
    await within(settleLayout(probe.page, SETTLE), "a layout that settles");
    assert.ok(probe.frames() >= MOVING_UNTIL + SETTLE.stableFrames, `returned after ${String(probe.frames())} frames`);
  });

  void it("starts counting again when the boxes move after a still frame", async () => {
    // Still for the first two frames, one short of the stable run, then moving again until the seventh.
    const probe = layoutPage((frames) => [0, 0, frames <= 2 ? 100 : frames < 7 ? 100 + frames : 206, 30]);
    await within(settleLayout(probe.page, SETTLE), "a layout that settles twice");
    assert.ok(probe.frames() >= 7 + SETTLE.stableFrames, `returned after ${String(probe.frames())} frames`);
  });

  void it("returns after the stable frames when the layout has not moved", async () => {
    const probe = layoutPage(() => [0, 0, 206, 30]);
    await within(settleLayout(probe.page, SETTLE), "a layout that is still");
    assert.equal(probe.frames(), SETTLE.stableFrames);
  });

  void it("waits for the fonts", async () => {
    let loaded = false;
    const fonts = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
      loaded = true;
    });
    const probe = layoutPage(() => [0, 0, 206, 30], fonts);
    await within(settleLayout(probe.page, SETTLE), "the fonts");
    assert.equal(loaded, true);
  });

  void it("gives up on a layout that never stops moving and scans what it finds", async () => {
    const probe = layoutPage((frames) => [frames, 0, 206, 30]);
    await within(settleLayout(probe.page, { ...SETTLE, timeoutMs: 40 }), "a layout that never settles");
    assert.ok(probe.frames() > 0);
  });
});
