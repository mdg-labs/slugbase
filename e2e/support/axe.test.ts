import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "@playwright/test";
import { settleAnimations } from "./axe.ts";

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
