import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/** The axe tags of WCAG 2.2 level AA: every level A and AA rule of 2.0, 2.1 and 2.2 (doc 08 section 5.2). */
export const WCAG_22_AA_TAGS: readonly string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * One reviewed exception: the axe rule and the selector axe reports for the
 * element, with the reason it is a false positive of a third-party component.
 */
export interface AllowlistEntry {
  readonly rule: string;
  readonly target: string;
  readonly reason: string;
}

const ALLOWLIST_FILE = new URL("../axe-allowlist.json", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the shape of an allowlist; an entry without a rule, a target and a reason is refused, not skipped. */
export function parseAllowlist(raw: unknown): AllowlistEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("axe-allowlist.json must hold a JSON array");
  }
  return raw.map((entry: unknown, index) => {
    if (!isRecord(entry)) {
      throw new Error(`axe-allowlist.json entry ${String(index)} must be an object`);
    }
    const { rule, target, reason, ...rest } = entry;
    const extra = Object.keys(rest);
    if (extra.length > 0) {
      throw new Error(`axe-allowlist.json entry ${String(index)} has unknown keys: ${extra.join(", ")}`);
    }
    if (typeof rule !== "string" || rule === "" || typeof target !== "string" || target === "") {
      throw new Error(`axe-allowlist.json entry ${String(index)} needs a non-empty "rule" and "target"`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`axe-allowlist.json entry ${String(index)} needs a "reason": an exception is reviewed`);
    }
    return { rule, target, reason };
  });
}

export function loadAllowlist(): AllowlistEntry[] {
  return parseAllowlist(JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8")) as unknown);
}

/** The selector of a node as the allowlist names it: the parts of a frame or shadow path joined by a space. */
function selectorOf(target: readonly unknown[]): string {
  return target.map((part) => (Array.isArray(part) ? part.join(" ") : String(part))).join(" ");
}

/**
 * Waits until every running animation of the page that ends has ended. A dialog that is still fading and
 * growing in has the contrast and the size of a frame on the way, not of the page the visitor gets; an
 * animation that never ends (a spinner) is left alone, and so is one that is paused or idle, whose finished
 * promise settles only once something plays it again. A dialog opens with a starting style that is removed a
 * frame later, and only then does its transition start, so the frames pass before the animations are read, and
 * they are read again once those have ended, in case one started meanwhile.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    let finite: Animation[];
    do {
      await frame();
      await frame();
      finite = document
        .getAnimations()
        .filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    } while (finite.length > 0);
  });
}

/** What `settleLayout` reads: the elements axe measures as targets, and how long it waits for them to stop moving. */
export interface LayoutSettle {
  /** Matches the elements whose boxes axe measures (links, buttons, fields and anything that takes focus). */
  readonly selector: string;
  /** How many frames in a row the boxes must be the same before the layout counts as settled. */
  readonly stableFrames: number;
  /** The longest the wait lasts, in milliseconds; the scan then runs on the layout it finds and reports it. */
  readonly timeoutMs: number;
}

export const LAYOUT_SETTLE: LayoutSettle = {
  selector: 'a[href], button, input, select, textarea, summary, [tabindex], [role="button"], [role="link"], [role="menuitem"], [role="tab"]',
  stableFrames: 3,
  timeoutMs: 2000,
};

/**
 * Waits until the fonts have loaded and the boxes of the page's targets have been the same for a few frames in a
 * row. `target-size` reads each target's box and the boxes of the targets around it once, when the scan reaches
 * the rule, so a page whose boxes are still moving (a sidebar that is making room, content that arrives and pushes
 * the rest down, text that swaps to its web font) is judged on a frame that no visitor rests on. An animation that
 * `settleAnimations` can see is not read again here; a layout that moves for a script's reasons, which no animation
 * announces, is. The wait is bounded: a page that never stops moving is scanned as it is after `timeoutMs`.
 */
export async function settleLayout(page: Page, settle: LayoutSettle = LAYOUT_SETTLE): Promise<void> {
  await page.evaluate(async ({ selector, stableFrames, timeoutMs }) => {
    const frame = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    const boxes = (): string =>
      Array.from(document.querySelectorAll(selector), (element) => {
        const { left, top, width, height } = element.getBoundingClientRect();
        return [left, top, width, height].map((value) => Math.round(value * 10)).join(",");
      }).join(";");
    await document.fonts.ready;
    const deadline = performance.now() + timeoutMs;
    let previous = boxes();
    let same = 0;
    while (same < stableFrames && performance.now() < deadline) {
      await frame();
      const current = boxes();
      same = current === previous ? same + 1 : 0;
      previous = current;
    }
  }, settle);
}

/**
 * Runs axe with the WCAG 2.2 AA rules on the page once its animations have ended and its layout has settled, and
 * returns one line per violating element that the allowlist does not name, with the reasons axe gives for it (the
 * size it measured, the targets that crowd it), so that a violation names its own cause.
 */
export async function findViolations(page: Page, allowlist: readonly AllowlistEntry[]): Promise<string[]> {
  await settleAnimations(page);
  await settleLayout(page);
  const results = await new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]).analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes
      .map((node) => ({ target: selectorOf(node.target), why: [...node.any, ...node.all, ...node.none].map((check) => check.message) }))
      .filter(({ target }) => !allowlist.some((entry) => entry.rule === violation.id && entry.target === target))
      .map(({ target, why }) => `${violation.id} (${violation.impact ?? "unknown impact"}): ${violation.help} at ${target}${why.length > 0 ? ` [${why.join("; ")}]` : ""}`),
  );
}
