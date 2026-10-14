import { expect, test as base, type Locator } from "@playwright/test";
import { findViolations, loadAllowlist } from "./axe.ts";

export interface App {
  /** Opens a path, waits for `ready` to show, and runs the accessibility check on the page. */
  visit: (path: string, ready: Locator) => Promise<void>;
  /** Runs the accessibility check on the page as it is now (after a theme change, say). */
  scan: () => Promise<void>;
}

/**
 * `test` with an `app` fixture that makes the accessibility check part of
 * visiting a page (doc 08 section 5.2): `visit` and `scan` fail the test on a
 * WCAG 2.2 AA violation that axe-allowlist.json does not name, and a test that
 * ends on a page it never scanned (reached by a click, say) fails too.
 */
export const test = base.extend<{ app: App }>({
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
        await scan();
      },
    });
    expect([...visited].filter((url) => !scanned.has(url)), "pages visited without an accessibility check").toEqual([]);
  },
});

export { expect };
