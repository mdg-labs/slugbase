import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { axe } from "vitest-axe";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  window.localStorage.clear();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

/**
 * Runs axe over the rendered markup and fails with the violations it names.
 * The page-level `region` rule is off: a component under test is not a page.
 */
export async function expectNoViolations(container: Element): Promise<void> {
  const results = await axe(container, { rules: { region: { enabled: false } } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}

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
