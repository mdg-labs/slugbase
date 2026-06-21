import { test, expect } from "../../fixtures/auth.js";
import {
  createSharingBookmark,
  createSharingFolder,
  setupTeamSharingWorkspace,
} from "../../fixtures/sharing-setup.js";
import { isCloudE2eProject } from "../../helpers/deployment-project.js";
import { e2eResourceSuffix } from "../../helpers/e2e-resource-id.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Compact share modal", () => {
  test("owner grants member via bookmark card share menu", async ({
    page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    test.skip(!isCloudE2eProject(testInfo), "Team sharing requires Cloud billing build");

    const setup = await setupTeamSharingWorkspace(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { cloud: true },
    );

    const suffix = e2eResourceSuffix(testInfo);
    const bookmarkTitle = `E2E Compact Share Bookmark ${suffix}`;
    const bookmark = await createSharingBookmark(page, setup.ownerSession, {
      title: bookmarkTitle,
      url: `https://example.com/e2e-compact-share-${suffix}`,
    });

    await loginAsWorker(page, setup.ownerWorkerIndex);
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    const card = page.locator(`[data-testid="bookmark-card-${bookmark.id}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "More options" }).click();
    await card.locator(`[data-testid="bookmark-card-share-${bookmark.id}"]`).click();

    await expect(page.locator('[data-testid="compact-share-modal"]')).toBeVisible();
    await page.selectOption(
      '[data-testid="compact-share-modal-target-select"]',
      setup.memberUserId,
    );
    await page.click('[data-testid="compact-share-modal-grant-button"]');

    await expect(
      page.locator(`[data-testid^="compact-share-modal-grant-"]`).filter({
        hasText: setup.memberName,
      }),
    ).toBeVisible();

    await page.click('[data-testid="compact-share-modal-done"]');
    await expect(page.locator('[data-testid="compact-share-modal"]')).toBeHidden();

    await expect(
      card.locator('[data-testid="sharing-recipients-badge"]'),
    ).toContainText("Shared with 1");
  });

  test("owner grants member via folder row share menu", async ({
    page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    test.skip(!isCloudE2eProject(testInfo), "Team sharing requires Cloud billing build");

    const setup = await setupTeamSharingWorkspace(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { cloud: true },
    );

    const suffix = e2eResourceSuffix(testInfo);
    const folderName = `E2E Compact Share Folder ${suffix}`;
    const folder = await createSharingFolder(page, setup.ownerSession, folderName);

    await loginAsWorker(page, setup.ownerWorkerIndex);
    await page.goto("/folders");
    await page.waitForSelector('[data-testid="folder-list-toolbar"]');

    const row = page.locator(`[data-testid="folder-list-item-${folder.id}"]`);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "More options" }).click();
    await row.locator(`[data-testid="folder-row-share-${folder.id}"]`).click();

    await expect(page.locator('[data-testid="compact-share-modal"]')).toBeVisible();
    await page.selectOption(
      '[data-testid="compact-share-modal-target-select"]',
      setup.memberUserId,
    );
    await page.click('[data-testid="compact-share-modal-grant-button"]');

    await expect(
      page.locator(`[data-testid^="compact-share-modal-grant-"]`).filter({
        hasText: setup.memberName,
      }),
    ).toBeVisible();

    await page.click('[data-testid="compact-share-modal-done"]');
    await expect(page.locator('[data-testid="compact-share-modal"]')).toBeHidden();

    await expect(
      row.locator('[data-testid="sharing-recipients-badge"]'),
    ).toContainText("Shared with 1");
  });
});
