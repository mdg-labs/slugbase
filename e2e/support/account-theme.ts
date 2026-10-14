import type { APIRequestContext, Page, Response } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appOrigin, STORAGE_STATE } from "./environment.ts";

// The theme of the signed-in journeys is the account's: once the app has the account it applies the
// account's saved theme, whatever the browser remembers. Every signed-in journey runs as the one
// account the global setup signed in, and the engines run in parallel, so a journey that depends on
// a theme sets it through `PATCH /api/v1/me` and holds the lock of the account's theme until the
// previous theme is back.

export type AccountTheme = "light" | "dark" | "system";

/** A directory that exists while a journey holds the theme of the account; the global setup removes one an earlier run left behind. */
export const THEME_LOCK = join(dirname(STORAGE_STATE), "account-theme.lock");

const ME_PATH = "/api/v1/me";
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 150_000;

/** The longest a journey may wait for the lock and for the restore at its end; it holds the fixture's timeout. */
export const THEME_FIXTURE_TIMEOUT_MS = LOCK_WAIT_MS + 30_000;

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function acquireLock(): Promise<void> {
  mkdirSync(dirname(THEME_LOCK), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(THEME_LOCK);
      return;
    } catch (error) {
      if (!isAlreadyThere(error)) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`the theme of the account stayed locked for ${String(LOCK_WAIT_MS / 1000)} seconds (${THEME_LOCK})`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/** Removes a lock that no journey holds any more; used by the global setup. */
export function clearLock(): void {
  rmSync(THEME_LOCK, { recursive: true, force: true });
}

function themeOf(value: unknown, what: string): AccountTheme {
  if (value !== "light" && value !== "dark" && value !== "system") {
    throw new Error(`${what} answered without a theme`);
  }
  return value;
}

async function currentTheme(request: APIRequestContext): Promise<AccountTheme> {
  const response = await request.get(ME_PATH);
  if (!response.ok()) {
    throw new Error(`GET ${ME_PATH} answered ${String(response.status())}`);
  }
  const me = (await response.json()) as { account?: { theme?: unknown } };
  return themeOf(me.account?.theme, `GET ${ME_PATH}`);
}

/** Saves the theme through `PATCH /api/v1/me` and checks the account the server answers with. */
async function saveTheme(request: APIRequestContext, theme: AccountTheme): Promise<void> {
  const response = await request.patch(ME_PATH, {
    // A mutation must come from the origin the server is configured with.
    headers: { origin: appOrigin() },
    data: { theme },
  });
  if (!response.ok()) {
    throw new Error(`PATCH ${ME_PATH} answered ${String(response.status())}`);
  }
  const saved = themeOf(((await response.json()) as { theme?: unknown }).theme, `PATCH ${ME_PATH}`);
  if (saved !== theme) {
    throw new Error(`PATCH ${ME_PATH} saved the theme ${saved}, not ${theme}`);
  }
}

/** What a journey sees of the account's theme: it sets one and the previous one comes back when the journey ends. */
export interface ThemeOfAccount {
  /** Sets the account's theme through `PATCH /api/v1/me`, before the page loads. */
  set: (theme: AccountTheme) => Promise<void>;
}

/**
 * Takes the lock of the account's theme, hands over `set`, and puts the theme the account had back
 * once `use` has ended, whether the journey passed or failed. A restore that fails fails the journey.
 */
export async function withAccountTheme(request: APIRequestContext, use: (theme: ThemeOfAccount) => Promise<void>): Promise<void> {
  await acquireLock();
  let previous: AccountTheme | undefined;
  try {
    await use({
      set: async (theme) => {
        previous ??= await currentTheme(request);
        await saveTheme(request, theme);
      },
    });
    if (previous !== undefined) {
      await saveTheme(request, previous);
    }
  } finally {
    rmSync(THEME_LOCK, { recursive: true });
  }
}

function isPreferenceSave(response: Response): boolean {
  return response.request().method() === "PATCH" && new URL(response.url()).pathname === ME_PATH;
}

/**
 * Runs an action that makes the app save the theme and returns once the server answered the save, so a
 * later restore of the account's theme cannot be overtaken by it. A save the server refuses throws.
 */
export async function savingTheme(page: Page, action: () => Promise<void>): Promise<void> {
  const answer = page.waitForResponse(isPreferenceSave);
  await action();
  const response = await answer;
  if (!response.ok()) {
    throw new Error(`the app's save of the theme answered ${String(response.status())}`);
  }
}
