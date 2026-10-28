import type { Page } from "@playwright/test";
import { message, type Locale } from "./catalog.ts";

// The home page (doc 03 section 2) shows its heading and its search before the dashboard has answered, and its
// content (the counts, the lists or the empty state, and the Getting started checklist) only once it has. A journey
// that checks the home page waits for the counts, so that the check covers what the page shows and not its loading
// state, and a dashboard that fails to load fails the journey.

/** The heading of the home page, which shows while the dashboard is still loading. */
export function homeHeading(page: Page, locale: Locale, name: string) {
  return page.getByRole("heading", { level: 1, name: message(locale, "home.title", { name }) });
}

/** The counts of the home page, which show once the dashboard has answered. */
export function homeCounts(page: Page, locale: Locale) {
  return page.getByRole("group", { name: message(locale, "home.counts.label"), exact: true });
}
