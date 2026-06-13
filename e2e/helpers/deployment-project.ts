import type { TestInfo } from '@playwright/test';

/** Playwright project for the hosted (billing-enabled) deployment build. */
export function isHostedE2eProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'hosted';
}

/** Playwright project for the self-hosted combined-container deployment build. */
export function isSelfHostedE2eProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'self-hosted';
}
