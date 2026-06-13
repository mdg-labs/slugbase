import type { TestInfo } from '@playwright/test';

/**
 * Unique suffix for slugs, tag names, workspace titles, etc.
 * Includes workerIndex, retry (Playwright re-runs), and project name so
 * parallel workers and flaky retries do not collide on the same workspace.
 */
export function e2eResourceSuffix(testInfo: TestInfo): string {
  const project = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
  return `w${testInfo.workerIndex}r${testInfo.retry}p${project}`;
}
