import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-accent");
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

export const SESSION_PATH = "/api/v1/me/sessions";

export const ME_PATH = "/api/v1/me";

export const ACCOUNT_BODY = {
  id: "0192f3a0-bbbb-7000-8000-000000000001",
  email: "ada@example.org",
  displayName: "Ada Lovelace",
  locale: "en",
  theme: "system",
  accent: null,
  defaultView: "grid",
  singleKeyShortcuts: true,
  signinAlerts: true,
  aiOptOut: false,
  analyticsConsent: "unset",
  onboarding: { browserSetupDone: false, importDone: false, checklistDismissed: false },
  emailVerified: true,
  hasPassword: true,
  mfaEnabled: false,
  isInstanceAdmin: false,
  pendingEmail: null,
} as const;

export const WORKSPACES_PATH = "/api/v1/workspaces";

export const ACTIVE_WORKSPACE_PATH = "/api/v1/session/active-workspace";

export const WORKSPACE_ID = "0192f3a0-cccc-7000-8000-000000000001";

export const WORKSPACE_NAME = "Ada's Workspace";

/** The one workspace the account of a test server is a member of and acts in. */
export const MEMBERSHIPS_BODY: { workspaceId: string; name: string; role: "owner" }[] = [
  { workspaceId: WORKSPACE_ID, name: WORKSPACE_NAME, role: "owner" },
];

/** What `GET /workspaces` answers for that account: the one workspace, and no creation. */
export const WORKSPACE_LIST_BODY = {
  items: [{ id: WORKSPACE_ID, name: WORKSPACE_NAME, role: "owner", memberCount: 1 }],
  canCreate: false,
} as const;

/** `GET /me` for `account`, who is a member of the one workspace and acts in it. */
export function meOf<Account extends object>(account: Account): { account: Account; memberships: typeof MEMBERSHIPS_BODY; activeWorkspaceId: string } {
  return { account, memberships: MEMBERSHIPS_BODY, activeWorkspaceId: WORKSPACE_ID };
}

/** The signed-in account of a test server. It chose the language of the browser, so a test that opens the app in German sees German. */
export function meBody(): object {
  const german = globalThis.navigator.languages.some((language) => language.toLowerCase().startsWith("de"));
  return meOf(german ? { ...ACCOUNT_BODY, locale: "de" } : ACCOUNT_BODY);
}

export const SESSION_BODY = { items: [], nextCursor: null } as const;

/**
 * The answers of a server with a signed-in visitor: the configuration, the session check, their account, the
 * list of their workspaces, and `other` for every other call.
 */
export function signedIn(
  request: Request,
  other: (request: Request) => Promise<Response> = () => Promise.reject(new Error("unexpected call")),
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/config") {
    return Promise.resolve(json(CONFIG_BODY));
  }
  if (pathname === ME_PATH && request.method === "GET") {
    return Promise.resolve(json(meBody()));
  }
  if (pathname === WORKSPACES_PATH && request.method === "GET") {
    return Promise.resolve(json(WORKSPACE_LIST_BODY));
  }
  return pathname === SESSION_PATH ? Promise.resolve(json(SESSION_BODY)) : other(request);
}

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
