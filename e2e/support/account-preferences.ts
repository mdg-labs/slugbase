import type { APIRequestContext, Page, Response } from "@playwright/test";
import { dirname, join } from "node:path";
import { appOrigin, STORAGE_STATE } from "./environment.ts";
import { clearPreferencesLock, enter, leave } from "./preferences-lock.ts";

// The theme and the language of the signed-in journeys are the account's: once the app has the account it applies the account's saved theme and
// locale, whatever the browser remembers. Every signed-in journey runs as the one account the setup project (tests/first-run.setup.ts) signed in,
// and the engines run in parallel, so a journey declares the theme and the locale it needs (`test.use({ preferences })`, the language in English
// when it declares nothing) and holds the lock of the account's preferences until it ends, with those values in place. Journeys that ask for the
// same language and do not set the theme hold the lock together; one that sets the theme, asks for another language, or acts on what the workspace
// holds (`accountAlone`) waits for the others to end and holds it alone (support/preferences-lock.ts). The values the account had come back when the last of the holders ends.

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
// The requests that put the values in place and back are made with the lock held, so each is bounded: a server that does not answer fails the journey and does not keep the others waiting.
const REQUEST_MS = 30_000;
// A journey that needs values other than the ones in force waits for the holders to end, one group at a time; the sharing journey, which sets
// the theme and holds the lock alone for the minute it takes, is the longest in the queue.
const LOCK_WAIT_MS = 300_000;

/** The longest a journey may wait for the lock and for the restore at its end; it holds the fixture's timeout. */
export const PREFERENCES_FIXTURE_TIMEOUT_MS = LOCK_WAIT_MS + 30_000;

/** Removes a lock that no journey holds any more; used by the global setup. */
export function clearLock(): void {
  clearPreferencesLock(PREFERENCES_LOCK);
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
  const response = await request.get(ME_PATH, { timeout: REQUEST_MS });
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
    timeout: REQUEST_MS,
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

/** What a journey sees of the account's preferences: the ones it declared are in place from the start. */
export interface PreferencesOfAccount {
  /**
   * Checks that the journey declared what it sets (`test.use({ preferences })`): the values are in place before the page loads, and the lock
   * is taken for them before the journey starts, so a journey cannot ask for others once it runs.
   */
  set: (preferences: Preferences) => Promise<void>;
}

/** The theme and the locale the account had, for the ones the journeys asked for; they come back at the end. */
type Previous = Preferences;

function show(preferences: Preferences): string {
  return JSON.stringify(preferences);
}

/**
 * Takes the lock of the account's preferences for `wanted` (alone, if `alone`), with those values in place, hands over `set`, and gives the lock up once `use`
 * has ended, whether the journey passed or failed. The journey that finds the lock free puts the values in place, saving only the ones that
 * differ from the account's; the last one of a group of holders that share puts the previous ones back. A restore that fails fails the journey.
 */
export async function withAccountPreferences(request: APIRequestContext, wanted: Preferences, alone: boolean, use: (account: PreferencesOfAccount) => Promise<void>): Promise<void> {
  const id = await enter(PREFERENCES_LOCK, alone ? { ...wanted, alone } : wanted, {
    waitMs: LOCK_WAIT_MS,
    pollMs: LOCK_POLL_MS,
    apply: async (): Promise<Previous> => {
      const current = await currentPreferences(request);
      const previous: Previous = {};
      const changed: Preferences = {};
      // Every value the journeys ask for goes back at the end, in place or not: a journey may toggle the theme in the page.
      if (wanted.theme !== undefined) {
        previous.theme = current.theme;
        if (wanted.theme !== current.theme) {
          changed.theme = wanted.theme;
        }
      }
      if (wanted.locale !== undefined) {
        previous.locale = current.locale;
        if (wanted.locale !== current.locale) {
          changed.locale = wanted.locale;
        }
      }
      if (Object.keys(changed).length > 0) {
        await savePreferences(request, changed);
      }
      return previous;
    },
  });
  try {
    await use({
      set: (preferences) => {
        for (const key of ["theme", "locale"] as const) {
          if (preferences[key] !== undefined && preferences[key] !== wanted[key]) {
            return Promise.reject(new Error(`the journey sets ${show(preferences)} but declared ${show(wanted)}; declare it with test.use({ preferences })`));
          }
        }
        return Promise.resolve();
      },
    });
  } finally {
    await leave(
      PREFERENCES_LOCK,
      id,
      async (stored) => {
        const previous = stored as Previous;
        if (Object.keys(previous).length > 0) {
          await savePreferences(request, previous);
        }
      },
      LOCK_WAIT_MS,
    );
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
