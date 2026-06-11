import { test as base, expect, type Page } from '@playwright/test';

export interface E2eFixtures {
  /**
   * Perform programmatic API login and return the cookie header
   * that can be used to set storageState for subsequent browser tests.
   */
  loginViaApi: (opts?: { email?: string; password?: string }) => Promise<string>;

  /**
   * Authenticated page context — calls loginViaApi first, then
   * sets the session cookie on the page before each test.
   */
  authedPage: Page;
}

/**
 * Resolve the API base URL from the test's context.
 * For the `hosted` project, the API is on a separate port.
 * For `self-hosted`, API and web share the same origin.
 */
function resolveApiUrl(page: Page): string {
  const header = page.context().request.defaultHeaders()?.['X-E2E-Base-URL-API'];
  if (header) return header;

  // Fallback: derive from page URL origin
  const origin = new URL(page.url()).origin;
  const project = page.context()['_project']?.['name'];
  if (project === 'hosted') {
    // In hosted mode web is on :4002, API on :4001
    return origin.replace(/:4002$/, ':4001');
  }
  return origin;
}

export const test = base.extend<E2eFixtures>({
  loginViaApi: async ({ page }, use) => {
    const apiUrl = resolveApiUrl(page);
    const email = process.env.E2E_TEST_EMAIL ?? 'e2e@slugbase.test';
    const password = process.env.E2E_TEST_PASSWORD ?? 'e2e-test-password';

    const res = await page.request.post(`${apiUrl}/api/v1/auth/login`, {
      data: { email, password },
    });
    expect(res.ok(), `API login failed: ${res.status()} ${res.statusText()}`).toBeTruthy();

    // Extract the session cookie from the Set-Cookie header
    const setCookie = res.headers()['set-cookie'] ?? res.headers()['Set-Cookie'];
    expect(setCookie, 'Login response missing Set-Cookie').toBeTruthy();

    // Return the raw cookie header value for use as a cookie string
    const cookie = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
    return cookie;
  },

  authedPage: async ({ page, loginViaApi }, use) => {
    const cookieString = await loginViaApi();
    const cookies = cookieString.split(';').map((pair) => {
      const [name, ...rest] = pair.trim().split('=');
      return {
        name: name.trim(),
        value: rest.join('=').split(';')[0].trim(),
        domain: new URL(page.url()).hostname,
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      };
    });

    await page.context().addCookies(cookies);
    await use(page);
  },
});

export { expect } from '@playwright/test';