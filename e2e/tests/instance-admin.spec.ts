import type { Page } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { ensureSharedMember } from "../support/member.ts";
import { SHARED_MEMBER_HOOK_TIMEOUT_MS, sharedMemberState } from "../support/member-shared.ts";
import { expect, test } from "../support/test.ts";

// The instance admin journey (doc 08 section 5.1, doc 03 section 12, doc 04 section 10.10, Q18): the owner of the instance, who is
// its admin, opens the overview, the accounts, the workspaces and the settings and status of the instance, and an ordinary member who
// opens the admin area is shown the 403 page. The overview shows the version and the migration level the server reports and a link
// to the public releases page that opens in a tab of its own and hands the new page nothing of this one (Q18). Each page it reaches is
// scanned for WCAG 2.2 AA violations (tests/axe.spec.ts, support/axe.ts). Every text is read from the catalogs of packages/web.
//
// The member is one that `ensureSharedMember` already provisions for the palette journey, so no invitation of its own is accepted
// (doc 08 section 5.1, redeeming tokens). The language of the owner's account is the account's, which other journeys change while
// they run, so the owner's pages are visited with it set to English.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

const INSTANCE_STATUS = "/api/v1/instance/status";

/** The page has stopped loading: no skeleton of a wait is left on it. */
async function expectLoaded(page: Page): Promise<void> {
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
}

function heading(page: Page, key: string) {
  return page.getByRole("heading", { level: 1, name: en(key), exact: true });
}

test.describe("instance admin journey, as the owner of the instance", () => {
  test.beforeEach(async ({ account }) => {
    await account.set({ locale: "en" });
  });

  test("shows the version, the migration level and the Releases link on the overview", async ({ page, app }) => {
    await app.visit("/admin", heading(page, "admin.overview.title"));
    await expectLoaded(page);

    const response = await page.request.get(INSTANCE_STATUS);
    expect(response.status(), `GET ${INSTANCE_STATUS}`).toBe(200);
    const status = (await response.json()) as { version?: unknown; migrations?: { applied?: unknown; expected?: unknown } };
    const { version, migrations } = status;
    if (typeof version !== "string" || typeof migrations?.applied !== "number" || typeof migrations.expected !== "number") {
      throw new Error(`GET ${INSTANCE_STATUS} answered without a version and a migration level`);
    }

    const build = page.locator("[data-slot='card']").filter({ has: page.getByRole("heading", { name: en("admin.overview.build.title"), exact: true }) });
    const versionRow = build.getByRole("term").filter({ hasText: en("admin.overview.build.version") });
    await expect(versionRow).toBeVisible();
    await expect(build.getByText(version, { exact: true })).toBeVisible();
    await expect(build.getByText(en("admin.overview.build.applied", { applied: String(migrations.applied), expected: String(migrations.expected) }), { exact: true })).toBeVisible();
    await expect(build.getByText(en("admin.overview.build.upToDate"), { exact: true })).toBeVisible();

    // The link goes to the releases page, which the instance asks no host about (Q18), in a tab of its own that cannot reach this one.
    const releases = build.getByRole("link", { name: en("admin.overview.build.releases"), exact: true });
    await expect(releases).toHaveAttribute("href", "https://github.com/mdg-labs/slugbase/releases");
    await expect(releases).toHaveAttribute("target", "_blank");
    await expect(releases).toHaveAttribute("rel", "noopener noreferrer");
    await app.scan();
  });

  test("lists the accounts of the instance", async ({ page, app }) => {
    await app.visit("/admin/accounts", heading(page, "admin.accounts.title"));
    await expectLoaded(page);
    await expect(page.getByRole("table", { name: en("admin.accounts.table.label"), exact: true })).toBeVisible();
    await app.scan();
  });

  test("lists the workspaces of the instance", async ({ page, app }) => {
    await app.visit("/admin/workspaces", heading(page, "admin.workspaces.title"));
    await expectLoaded(page);
    await app.scan();
  });

  test("shows the settings and the status of the instance", async ({ page, app }) => {
    await app.visit("/admin/settings", heading(page, "admin.settings.title"));
    await expectLoaded(page);
    await app.scan();
  });
});

test.describe("instance admin journey, as a member who is not an instance admin", () => {
  test.use({ storageState: sharedMemberState("palette") });

  test.beforeAll(async ({ playwright }) => {
    // The hook provisions the member or waits for the journey that does, which takes longer than the 30 seconds of the default timeout.
    test.setTimeout(SHARED_MEMBER_HOOK_TIMEOUT_MS);
    await ensureSharedMember(playwright, "palette");
  });

  test("shows the 403 page in the admin area, and none of its pages", async ({ page, app }) => {
    await app.visit("/admin", heading(page, "errorPage.forbidden.title"));
    await expect(page.getByText(en("errorPage.forbidden.description"), { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: en("admin.nav.accounts"), exact: true })).toHaveCount(0);
    await app.scan();
  });
});
