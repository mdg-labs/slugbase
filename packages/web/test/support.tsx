import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  window.localStorage.clear();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

/** jsdom has no matchMedia, which the theme provider reads. `narrow` makes the `max-width` queries of the drawer breakpoint match. */
export function stubMatchMedia(narrow = false): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom lacks ResizeObserver and Element.getAnimations, which Base UI reads. */
export function stubBrowserApis(): void {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
}

export const PRODUCT_NAME = "Bookmarks Test Instance";

export const CONFIG_BODY = {
  apiVersion: "v1",
  defaultLocale: "en",
  docsBaseUrl: "https://slugbase.app/docs",
  features: { ai: false, mail: false },
  locales: ["en", "de"],
  origin: "http://localhost:3000",
  product: { name: PRODUCT_NAME, version: "0.0.0" },
} as const;

export function json(body: unknown, init: ResponseInit & { contentType?: string } = {}): Response {
  const { contentType = "application/json", ...rest } = init;
  return new Response(JSON.stringify(body), {
    ...rest,
    headers: { "Content-Type": contentType, ...(rest.headers as Record<string, string> | undefined) },
  });
}

export function problem(status: number, code: string, requestId: string, detail = "internal detail"): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail, requestId },
    { status, contentType: "application/problem+json" },
  );
}

/**
 * Renders inside an async act: the app suspends on a promise that settles after
 * the first render, and React flushes the retry only inside an act scope.
 */
export async function renderApp(ui: ReactElement): Promise<RenderResult> {
  let result: RenderResult | undefined;
  await act(async () => {
    result = render(ui);
    await Promise.resolve();
  });
  if (result === undefined) {
    throw new Error("render did not run");
  }
  return result;
}
