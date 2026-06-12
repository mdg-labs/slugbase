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

/**
 * Poll until the active workspace plan sticks and the audit log API is reachable.
 * Parallel hosted specs on the same worker flip plan to free; this avoids flakes
 * when asserting team-plan audit settings.
 */
export async function waitForTeamAuditLogAccess(
  page: Page,
  sessionCookie: string,
  csrfToken: string,
  timeoutMs = 20_000,
): Promise<void> {
  await expect.poll(async () => {
    await setActiveWorkspacePlan(page, sessionCookie, csrfToken, 'team');

    const workspaceRes = await page.request.get(`${resolveApiUrl()}/workspaces/active`, {
      headers: { Cookie: sessionCookie },
    });
    if (!workspaceRes.ok()) return 'workspace-error';

    const workspace = (await workspaceRes.json()) as { plan: string };
    if (workspace.plan !== 'team') return `plan-${workspace.plan}`;

    const auditRes = await page.request.get(
      `${resolveApiUrl()}/audit/events?page=0&pageSize=10`,
      { headers: { Cookie: sessionCookie } },
    );
    return auditRes.status();
  }, { timeout: timeoutMs }).toBe(200);
}
