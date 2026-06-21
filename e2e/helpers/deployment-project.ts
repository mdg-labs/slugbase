import type { TestInfo } from '@playwright/test';

/** Playwright project for the Cloud (billing-enabled) deployment build. */
export function isCloudE2eProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'cloud';
}

/** Playwright project for the CE combined-container deployment build. */
export function isCeE2eProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'ce';
}
