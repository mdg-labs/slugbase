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
 * Waits until every animation of the page that ends has ended. A dialog that is still fading and growing in
 * has the contrast and the size of a frame on the way, not of the page the visitor gets; an animation that
 * never ends (a spinner) is left alone.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/**
 * Runs axe with the WCAG 2.2 AA rules on the page as it is now and returns one
 * line per violating element that the allowlist does not name.
 */
export async function findViolations(page: Page, allowlist: readonly AllowlistEntry[]): Promise<string[]> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]).analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes
      .map((node) => selectorOf(node.target))
      .filter((target) => !allowlist.some((entry) => entry.rule === violation.id && entry.target === target))
      .map((target) => `${violation.id} (${violation.impact ?? "unknown impact"}): ${violation.help} at ${target}`),
  );
}
