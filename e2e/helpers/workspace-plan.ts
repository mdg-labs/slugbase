import { expect, type Page } from '@playwright/test';

function resolveApiUrl(): string {
  return process.env.E2E_BASE_URL_API
    ?? process.env.E2E_BASE_URL_SELF_HOSTED
    ?? 'http://localhost:4001';
}

/** Set the active workspace plan via API (avoids slow in-page fetch + CSRF round-trip). */
export async function setActiveWorkspacePlan(
  page: Page,
  sessionCookie: string,
  csrfToken: string,
  plan: 'free' | 'personal' | 'team',
): Promise<void> {
  const res = await page.request.patch(`${resolveApiUrl()}/workspaces/active`, {
    headers: {
      Cookie: sessionCookie,
      'x-csrf-token': csrfToken,
      'Content-Type': 'application/json',
    },
    data: { plan },
  });
  expect(res.ok(), `Workspace plan ${plan} failed: ${res.status()}`).toBeTruthy();
}
