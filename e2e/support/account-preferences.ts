import type { APIRequestContext, Page, Response } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appOrigin, STORAGE_STATE } from "./environment.ts";

// The theme and the language of the signed-in journeys are the account's: once the app has the account
// it applies the account's saved theme and locale, whatever the browser remembers. Every signed-in
// journey runs as the one account the setup project (tests/first-run.setup.ts) signed in, and the engines run in parallel, so a
// journey that depends on a theme or a locale sets it through `PATCH /api/v1/me` and holds the lock of
// the account's preferences until the previous ones are back. A signed-in journey that reads either
// takes the lock as well, so that it never runs while another journey holds a different value.

export type AccountTheme = "light" | "dark" | "system";
export type AccountLocale = "en" | "de";

/** What a journey may set: the account's theme and its locale. */
export interface Preferences {
  theme?: AccountTheme;
  locale?: AccountLocale;
}

/** A directory that exists while a journey holds the preferences of the account; the global setup removes one an earlier run left behind. */
export const PREFERENCES_LOCK = join(dirname(STORAGE_STATE), "account-preferences.lock");

const ME_PATH = "/api/v1/me";
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 150_000;

/** The longest a journey may wait for the lock and for the restore at its end; it holds the fixture's timeout. */
export const PREFERENCES_FIXTURE_TIMEOUT_MS = LOCK_WAIT_MS + 30_000;

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function acquireLock(): Promise<void> {
  mkdirSync(dirname(PREFERENCES_LOCK), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(PREFERENCES_LOCK);
      return;
    } catch (error) {
      if (!isAlreadyThere(error)) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`the preferences of the account stayed locked for ${String(LOCK_WAIT_MS / 1000)} seconds (${PREFERENCES_LOCK})`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/** Removes a lock that no journey holds any more; used by the global setup. */
export function clearLock(): void {
  rmSync(PREFERENCES_LOCK, { recursive: true, force: true });
}

function themeOf(value: unknown, what: string): AccountTheme {
  if (value !== "light" && value !== "dark" && value !== "system") {
    throw new Error(`${what} answered without a theme`);
  }
  return value;
}

function localeOf(value: unknown, what: string): AccountLocale {
  if (value !== "en" && value !== "de") {
    throw new Error(`${what} answered without a locale`);
  }
  return value;
}

async function currentPreferences(request: APIRequestContext): Promise<Required<Preferences>> {
  const response = await request.get(ME_PATH);
  if (!response.ok()) {
    throw new Error(`GET ${ME_PATH} answered ${String(response.status())}`);
  }
  const me = (await response.json()) as { account?: { theme?: unknown; locale?: unknown } };
  return {
    theme: themeOf(me.account?.theme, `GET ${ME_PATH}`),
    locale: localeOf(me.account?.locale, `GET ${ME_PATH}`),
  };
}

/** Saves the preferences through `PATCH /api/v1/me` and checks the account the server answers with. */
async function savePreferences(request: APIRequestContext, preferences: Preferences): Promise<void> {
  const response = await request.patch(ME_PATH, {
    // A mutation must come from the origin the server is configured with.
    headers: { origin: appOrigin() },
    data: preferences,
  });
  if (!response.ok()) {
    throw new Error(`PATCH ${ME_PATH} answered ${String(response.status())}`);
  }
  const saved = (await response.json()) as { theme?: unknown; locale?: unknown };
  if (preferences.theme !== undefined) {
    const theme = themeOf(saved.theme, `PATCH ${ME_PATH}`);
    if (theme !== preferences.theme) {
      throw new Error(`PATCH ${ME_PATH} saved the theme ${theme}, not ${preferences.theme}`);
    }
  }
  if (preferences.locale !== undefined) {
    const locale = localeOf(saved.locale, `PATCH ${ME_PATH}`);
    if (locale !== preferences.locale) {
      throw new Error(`PATCH ${ME_PATH} saved the locale ${locale}, not ${preferences.locale}`);
    }
  }
}

/** What a journey sees of the account's preferences: it sets some and the previous ones come back when the journey ends. */
export interface PreferencesOfAccount {
  /** Sets the account's theme and locale through `PATCH /api/v1/me`, before the page loads. */
  set: (preferences: Preferences) => Promise<void>;
}

/**
 * Takes the lock of the account's preferences, hands over `set`, and puts back the theme and the locale
 * the account had, for those the journey set, once `use` has ended, whether the journey passed or failed.
 * A restore that fails fails the journey.
 */
export async function withAccountPreferences(request: APIRequestContext, use: (account: PreferencesOfAccount) => Promise<void>): Promise<void> {
  await acquireLock();
  let previous: Required<Preferences> | undefined;
  const changed: Preferences = {};
  try {
    await use({
      set: async (preferences) => {
        previous ??= await currentPreferences(request);
        if (preferences.theme !== undefined) {
          changed.theme = previous.theme;
        }
        if (preferences.locale !== undefined) {
          changed.locale = previous.locale;
        }
        await savePreferences(request, preferences);
      },
    });
    if (Object.keys(changed).length > 0) {
      await savePreferences(request, changed);
    }
  } finally {
    rmSync(PREFERENCES_LOCK, { recursive: true });
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
