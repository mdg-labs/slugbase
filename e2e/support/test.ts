import { expect, test as base, type Locator } from "@playwright/test";
import { PREFERENCES_FIXTURE_TIMEOUT_MS, withAccountPreferences, type Preferences, type PreferencesOfAccount } from "./account-preferences.ts";
import { findViolations, loadAllowlist } from "./axe.ts";

export interface App {
  /** Opens a path, waits for `ready` to show, and runs the accessibility check on the page it ends on (after any redirect). */
  visit: (path: string, ready: Locator) => Promise<void>;
  /** Runs the accessibility check on the page as it is now (after a theme change, say). */
  scan: () => Promise<void>;
}

export interface Fixtures {
  app: App;
  /**
   * The theme and the locale of the signed-in account, for a journey that reads either (see account-preferences.ts):
   * the journey holds the account's preferences until it ends, with the values it declared in place, and the ones that
   * were changed go back to what the account had once the last journey that holds them ends. A journey of a visitor without a session has no account and does not use it.
   */
  account: PreferencesOfAccount;
  /**
   * The theme and the locale the signed-in account is given before a journey that uses `account` starts, and holds until it ends. A journey
   * that reads the language and does not set the theme leaves it at English; one that needs another language or a theme says so with
   * `test.use({ preferences })`, and then holds the account's preferences alone (support/preferences-lock.ts).
   */
  preferences: Preferences;
  /**
   * Whether the journey holds the account's preferences alone, which keeps every other journey that uses `account` away from the
   * workspace while it runs: for a journey that counts, selects or removes what the workspace holds. False for a journey that makes
   * its own things and looks at those only.
   */
  accountAlone: boolean;
}

/**
 * `test` with an `app` fixture that makes the accessibility check part of
 * visiting a page (doc 08 section 5.2): `visit` and `scan` fail the test on a
 * WCAG 2.2 AA violation that axe-allowlist.json does not name, and a test that
 * ends on a page it never scanned (reached by a click, say) fails too.
 */
export const test = base.extend<Fixtures>({
  preferences: [{ locale: "en" }, { option: true }],
  accountAlone: [false, { option: true }],
  account: [
    async ({ request, preferences, accountAlone }, use) => {
      await withAccountPreferences(request, preferences, accountAlone, use);
    },
    { timeout: PREFERENCES_FIXTURE_TIMEOUT_MS },
  ],
  app: async ({ page }, use) => {
    const allowlist = loadAllowlist();
    const visited = new Set<string>();
    const scanned = new Set<string>();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() !== "about:blank") {
        visited.add(frame.url());
      }
    });
    const scan = async (): Promise<void> => {
      scanned.add(page.url());
      expect(await findViolations(page, allowlist), "WCAG 2.2 AA violations on " + page.url()).toEqual([]);
    };
    await use({
      scan,
      visit: async (path, ready) => {
        await page.goto(path);
        await expect(ready).toBeVisible();
        // A page that sends the visitor elsewhere (the sign-in page, for a visitor without a session)
        // is covered by the check of the page it ends on.
        const requested = new URL(path, page.url()).href;
        await scan();
        scanned.add(requested);
      },
    });
    expect([...visited].filter((url) => !scanned.has(url)), "pages visited without an accessibility check").toEqual([]);
  },
});

export { expect };
