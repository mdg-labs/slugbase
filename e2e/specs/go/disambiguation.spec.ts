import { test, expect } from "../../fixtures/auth.js";
import { setupSharedSlugDisambiguation } from "../../fixtures/sharing-setup.js";
import { isHostedE2eProject } from "../../helpers/deployment-project.js";

test.describe("Go disambiguation", () => {
  test("two bookmarks with same slug shows disambiguation page, user picks candidate", async ({
    authedPage: page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    const setup = await setupSharedSlugDisambiguation(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { hosted: isHostedE2eProject(testInfo) },
    );

    await page.goto(`/go/${setup.slug}`);
    await expect(page.locator('[data-testid="go-disambiguation-page"]')).toBeVisible();
    await expect(
      page.locator(`[data-testid="go-disambiguation-candidate-${setup.userBBookmarkId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="go-disambiguation-candidate-${setup.userABookmarkId}"]`),
    ).toBeVisible();

    await page.click(`[data-testid="go-disambiguation-candidate-${setup.userBBookmarkId}"]`);
    await page.click('[data-testid="go-confirm-btn"]');
    await page.waitForURL(setup.userBTargetUrl, { timeout: 10_000 });

    await page.goto(`/go/${setup.slug}`);
    await expect(page.locator('[data-testid="go-disambiguation-page"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("disambiguation with remember preference saves choice", async ({
    authedPage: page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    const setup = await setupSharedSlugDisambiguation(
      page,
      testInfo.workerIndex,
      { sessionCookie, csrfToken },
      { hosted: isHostedE2eProject(testInfo) },
    );

    await page.goto(`/go/${setup.slug}`);
    await expect(page.locator('[data-testid="go-disambiguation-page"]')).toBeVisible();

    await page.click(`[data-testid="go-disambiguation-candidate-${setup.userBBookmarkId}"]`);
    await page.check('[data-testid="go-remember-pref-toggle"]');
    await page.click('[data-testid="go-confirm-btn"]');
    await page.waitForURL(setup.userBTargetUrl, { timeout: 10_000 });

    await page.goto(`/go/${setup.slug}`);
    await page.waitForURL(setup.userBTargetUrl, { timeout: 10_000 });
    expect(page.url()).toBe(setup.userBTargetUrl);

    await page.goto('/go');
    await expect(page.locator('[data-testid="forwarding-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="forwarding-prefs-list"]')).toBeVisible();
    await expect(page.getByText(setup.userBTitle, { exact: true })).toBeVisible();

    const prefRow = page
      .locator('[data-testid^="forwarding-pref-row-"]')
      .filter({ hasText: setup.slug });
    await expect(prefRow).toHaveCount(1);

    const deleteButton = prefRow.locator('[data-testid^="forwarding-pref-delete-"]');
    await deleteButton.click();
    await expect(page.locator('[data-testid="forwarding-pref-delete-dialog"]')).toBeVisible();
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('[data-testid="forwarding-pref-delete-dialog"]')).toBeHidden({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="forwarding-prefs-empty"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.goto(`/go/${setup.slug}`);
    await expect(page.locator('[data-testid="go-disambiguation-page"]')).toBeVisible({
      timeout: 10_000,
    });
  });
});
