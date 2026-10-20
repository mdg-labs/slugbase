import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "@playwright/test";
import { settleAnimations } from "./axe.ts";

interface FakeAnimation {
  readonly playState: AnimationPlayState;
  readonly effect: { getComputedTiming: () => { iterations: number } };
  readonly finished: Promise<void>;
}

function animation(playState: AnimationPlayState, iterations: number, finished: Promise<void>): FakeAnimation {
  return { playState, effect: { getComputedTiming: () => ({ iterations }) }, finished };
}

const NEVER = new Promise<void>(() => undefined);

/** A page whose evaluate runs the callback here, against a document that holds the given animations. */
function pageWith(animations: readonly FakeAnimation[]): Page {
  Object.defineProperty(globalThis, "document", { value: { getAnimations: () => animations }, configurable: true });
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
  });

  void it("waits for a running animation that ends", async () => {
    let ended = false;
    const finished = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
      ended = true;
    });
    await within(settleAnimations(pageWith([animation("running", 1, finished)])), "a running animation");
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
