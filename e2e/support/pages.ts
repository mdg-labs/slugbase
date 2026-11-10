import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The pages of the app and the journey that visits each (doc 08 section 5.2). The accessibility check runs on every page a journey
// visits, so a page that no journey visits is never checked. Every route file under packages/web/src/routes/ is named here, either
// with the journey that reaches the page it renders and the text of that journey that does, or with the reason it renders no page of
// its own. A file whose name starts with `-` is not a route (the router ignores it) and needs no entry. support/pages.test.ts fails
// when a route file has no entry, when an entry names a file that is gone, when a journey is named that does not exist or does not
// hold the text, and when an exemption has no reason; adding a route therefore means adding a visit.

/** A page a journey visits and scans: the spec under tests/ and a piece of its text that reaches the page. */
export interface Visited {
  readonly spec: string;
  readonly visits: string;
}

/** A route file that renders no page of its own, and why. */
export interface Exempt {
  readonly exempt: string;
}

export type Coverage = Visited | Exempt;

export const ROUTES_DIR = new URL("../../packages/web/src/routes/", import.meta.url);
const TESTS_DIR = new URL("../tests/", import.meta.url);

const LAYOUT = "a layout: it renders the pages below it and no page of its own";
const FORWARDS = "forwards to the bookmark's address or shows the page for a slug nobody has, which the journeys of go.spec.ts and sharing.spec.ts scan; the route is a redirect";

/** Route file (relative to packages/web/src/routes/, with `/`) to the journey that visits it or the reason it is exempt. */
export const PAGES: Readonly<Record<string, Coverage>> = {
  "__root.tsx": { exempt: "the root layout and its error boundary: it renders the pages below it and no page of its own" },
  "_app.tsx": { exempt: LAYOUT },
  "_app/admin.tsx": { exempt: "a layout: the navigation of the admin pages, and the 403 page for an account that is not an instance admin, which tests/instance-admin.spec.ts scans" },
  "_app/settings.tsx": { exempt: LAYOUT },
  "_app/settings/index.tsx": { exempt: "a redirect to the account's profile" },
  "go.$slug.tsx": { exempt: FORWARDS },
  "go.$.tsx": { exempt: FORWARDS },

  "_app/index.tsx": { spec: "smoke.spec.ts", visits: 'app.visit("/", homeCounts' },
  "_app/$.tsx": { spec: "smoke.spec.ts", visits: '"errorPage.notFound.title"' },
  "_app/403.tsx": { spec: "pages.spec.ts", visits: '"/403"' },
  "_app/bookmarks.tsx": { spec: "bookmarks.spec.ts", visits: '"/bookmarks"' },
  "_app/folders.tsx": { spec: "folders-tags.spec.ts", visits: '"/folders"' },
  "_app/tags.tsx": { spec: "folders-tags.spec.ts", visits: '"/tags"' },
  "_app/forwarding.tsx": { spec: "go.spec.ts", visits: '"/forwarding"' },
  "_app/admin/index.tsx": { spec: "instance-admin.spec.ts", visits: '"/admin"' },
  "_app/admin/accounts.tsx": { spec: "instance-admin.spec.ts", visits: '"/admin/accounts"' },
  "_app/admin/workspaces.tsx": { spec: "instance-admin.spec.ts", visits: '"/admin/workspaces"' },
  "_app/admin/settings.tsx": { spec: "instance-admin.spec.ts", visits: '"/admin/settings"' },
  "_app/settings/account/index.tsx": { spec: "unsaved-route-guard.spec.ts", visits: 'app.visit("/settings/account"' },
  "_app/settings/account/data.tsx": { spec: "import-export.spec.ts", visits: 'DATA = "/settings/account/data"' },
  "_app/settings/account/preferences.tsx": { spec: "pages.spec.ts", visits: '"/settings/account/preferences"' },
  "_app/settings/account/security.tsx": { spec: "accounts.spec.ts", visits: '"/settings/account/security"' },
  "_app/settings/account/tokens.tsx": { spec: "api-tokens.spec.ts", visits: '"/settings/account/tokens"' },
  "_app/settings/workspace/index.tsx": { spec: "unsaved-route-guard.spec.ts", visits: 'app.visit("/settings/workspace"' },
  "_app/settings/workspace/ai.tsx": { spec: "pages.spec.ts", visits: '"/settings/workspace/ai"' },
  "_app/settings/workspace/audit.tsx": { spec: "pages.spec.ts", visits: '"/settings/workspace/audit"' },
  "_app/settings/workspace/members.tsx": { spec: "accounts.spec.ts", visits: '"/settings/workspace/members"' },
  "_app/settings/workspace/teams.tsx": { spec: "sharing.spec.ts", visits: '"/settings/workspace/teams"' },
  "email-change.cancel.tsx": { spec: "pages.spec.ts", visits: "/email-change/cancel#token=" },
  "email-change.confirm.tsx": { spec: "pages.spec.ts", visits: "/email-change/confirm#token=" },
  "forgot-password.tsx": { spec: "pages.spec.ts", visits: '"/forgot-password"' },
  "invite.$token.tsx": { spec: "accounts.spec.ts", visits: 'message("en", "invite.title")' },
  "login.tsx": { spec: "axe.spec.ts", visits: 'app.visit("/login"' },
  "login_.mfa.tsx": { spec: "accounts.spec.ts", visits: "\\/login\\/mfa" },
  "no-workspace.tsx": { spec: "pages.spec.ts", visits: '"/no-workspace"' },
  "register.tsx": { spec: "pages.spec.ts", visits: '"/register"' },
  "reset-password.tsx": { spec: "pages.spec.ts", visits: "/reset-password#token=" },
  "setup.tsx": { spec: "first-run.setup.ts", visits: "\\/setup$" },
  "verify-email.tsx": { spec: "pages.spec.ts", visits: "/verify-email#token=" },
};

/** The route files under `dir`, relative to it and with `/`, whatever is the platform's separator. The router ignores a file or a directory whose name starts with `-`. */
export function routeFiles(dir: URL = ROUTES_DIR): string[] {
  const root = dir.pathname;
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith("-")) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** The text of a journey under tests/, or `undefined` when there is no such file. */
export function readJourney(spec: string, dir: URL = TESTS_DIR): string | undefined {
  const path = new URL(spec, dir);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function isExempt(coverage: Coverage): coverage is Exempt {
  return "exempt" in coverage;
}

/**
 * What is wrong with the table for these route files, one sentence each; none when every route file is covered by a journey that
 * holds the text that reaches the page, or exempt with a reason.
 */
export function pageProblems(files: readonly string[], pages: Readonly<Record<string, Coverage>>, read: (spec: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!(file in pages)) {
      problems.push(`${file} is neither visited by a journey nor exempt: add it to PAGES in e2e/support/pages.ts with the journey that scans it, or with the reason it renders no page`);
    }
  }
  for (const [file, coverage] of Object.entries(pages)) {
    if (!files.includes(file)) {
      problems.push(`${file} is in PAGES but is not a route file: remove the entry`);
      continue;
    }
    if (isExempt(coverage)) {
      if (coverage.exempt.trim() === "") {
        problems.push(`${file} is exempt without a reason`);
      }
      continue;
    }
    const text = read(coverage.spec);
    if (text === undefined) {
      problems.push(`${file} is visited by ${coverage.spec}, which does not exist under e2e/tests/`);
    } else if (coverage.visits === "" || !text.includes(coverage.visits)) {
      problems.push(`${file} is visited by ${coverage.spec}, which does not hold ${JSON.stringify(coverage.visits)}`);
    }
  }
  return problems;
}
