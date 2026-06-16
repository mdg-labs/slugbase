import { test, expect } from "../../fixtures/auth.js";
import {
  createSharingBookmark,
  createSharingFolder,
  grantBookmarkShare,
  grantFolderShare,
  linkBookmarkToFolder,
  setupTeamSharingWorkspace,
} from "../../fixtures/sharing-setup.js";
import { isHostedE2eProject } from "../../helpers/deployment-project.js";
import { e2eResourceSuffix } from "../../helpers/e2e-resource-id.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Sharing recipients badge", () => {
  test("owner sees badge with recipient tooltip after direct grant", async ({
    page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    test.skip(!isHostedE2eProject(testInfo), "Team sharing requires hosted billing build");

    const setup = await setupTeamSharingWorkspace(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { hosted: true },
    );

    const suffix = e2eResourceSuffix(testInfo);
    const bookmark = await createSharingBookmark(page, setup.ownerSession, {
      title: `E2E Direct Share Badge ${suffix}`,
      url: `https://example.com/e2e-direct-badge-${suffix}`,
    });
    await grantBookmarkShare(page, setup.ownerSession, bookmark.id, setup.memberUserId);

    await loginAsWorker(page, setup.ownerWorkerIndex);
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    const card = page.locator(`[data-testid="bookmark-card-${bookmark.id}"]`);
    const badge = card.locator('[data-testid="sharing-recipients-badge"]');
    await expect(badge).toContainText("Shared with 1");

    await badge.hover();
    const tooltip = page.locator('[data-testid="sharing-recipients-tooltip"]');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });
    await expect(tooltip).toContainText(setup.memberName);
  });

  test("folder share shows transitive badge detail in popover", async ({
    page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    test.skip(!isHostedE2eProject(testInfo), "Team sharing requires hosted billing build");

    const setup = await setupTeamSharingWorkspace(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { hosted: true },
    );

    const suffix = e2eResourceSuffix(testInfo);
    const folderName = `E2E Folder Transitive ${suffix}`;
    const folder = await createSharingFolder(page, setup.ownerSession, folderName);
    const bookmark = await createSharingBookmark(page, setup.ownerSession, {
      title: `E2E Folder Transitive Bookmark ${suffix}`,
      url: `https://example.com/e2e-folder-transitive-${suffix}`,
    });
    await linkBookmarkToFolder(page, setup.ownerSession, folder.id, bookmark.id);
    await grantFolderShare(page, setup.ownerSession, folder.id, setup.memberUserId);

    await loginAsWorker(page, setup.ownerWorkerIndex);
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    const card = page.locator(`[data-testid="bookmark-card-${bookmark.id}"]`);
    const badge = card.locator('[data-testid="sharing-recipients-badge"]');
    await expect(badge).toContainText("Shared with 1");

    await badge.click();
    const popover = page.locator('[data-testid="sharing-recipients-popover"]');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("People with access");
    await expect(popover).toContainText(folderName);
    await expect(popover).toContainText(setup.memberName);
  });

  test("recipient sees shared-with-you badge on granted bookmark", async ({
    page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    test.skip(!isHostedE2eProject(testInfo), "Team sharing requires hosted billing build");

    const setup = await setupTeamSharingWorkspace(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { hosted: true },
    );

    const suffix = e2eResourceSuffix(testInfo);
    const bookmark = await createSharingBookmark(page, setup.ownerSession, {
      title: `E2E Recipient Badge ${suffix}`,
      url: `https://example.com/e2e-recipient-badge-${suffix}`,
    });
    await grantBookmarkShare(page, setup.ownerSession, bookmark.id, setup.memberUserId);

    await loginAsWorker(page, setup.memberWorkerIndex);
    await page.goto("/bookmarks?scope=shared-with-me");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    const card = page.locator(`[data-testid="bookmark-card-${bookmark.id}"]`);
    await expect(card).toBeVisible();
    await expect(
      card.locator('[data-testid="sharing-recipients-badge"]'),
    ).toContainText("Shared with you");
  });
});
