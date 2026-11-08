import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { axe } from "vitest-axe";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-accent");
  window.localStorage.clear();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

/**
 * The axe run in flight, if any. axe-core allows one run at a time, and a run
 * keeps going after the test that started it times out, so the next run waits
 * for it instead of failing with "Axe is already running".
 */
let lastRun: Promise<unknown> = Promise.resolve();

const AXE_OPTIONS = { rules: { region: { enabled: false } } };

/**
 * Runs axe over the rendered markup and fails with the violations it names.
 * The page-level `region` rule is off: a component under test is not a page.
 */
export async function expectNoViolations(container: Element): Promise<void> {
  const previous = lastRun;
  const run = previous.then(() => axe(container, AXE_OPTIONS));
  lastRun = run.catch(() => undefined);
  const results = await run;
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}

/**
 * Pays the once-per-file costs of the test environment before the first test
 * starts, so they are not charged to whichever test meets them first: the first
 * `getComputedStyle`, the first Testing Library role query and the first axe
 * run. With the host's cores shared by 24 busy loops they took 1.7-2.2 s,
 * 0.4-0.6 s and 0.7-1.2 s, against 0.07 s, 0.01 s and 0.04 s on an idle one.
 */
async function warmUp(): Promise<void> {
  render(
    <form>
      <label>
        Name
        <input type="text" />
      </label>
      <button type="button">Save</button>
    </form>,
  );
  getComputedStyle(screen.getByRole("button", { name: "Save" }));
  await axe(document.body, AXE_OPTIONS);
  cleanup();
}

await warmUp();

/** jsdom has no matchMedia; `narrow` makes the `max-md` breakpoint match. */
export function stubMatchMedia(narrow: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

export class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom lacks ResizeObserver and Element.getAnimations, which Base UI reads. */
export function stubBrowserApis(): void {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
}

export interface CookieStoreSpy {
  set: ReturnType<typeof vi.fn<(cookie: { name: string; value: string }) => Promise<void>>>;
}

/** The sidebar persists its state through the Cookie Store API, which jsdom lacks. */
export function stubCookieStore(): CookieStoreSpy {
  const spy: CookieStoreSpy = { set: vi.fn(() => Promise.resolve()) };
  vi.stubGlobal("cookieStore", spy);
  return spy;
}
