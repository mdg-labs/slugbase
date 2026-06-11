import { test as base, expect, type Page } from '@playwright/test';

const STORAGE_STATE_PATH = '.auth-storage.json';

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

  /**
   * Pre-authenticated storage state file created via API login.
   * Downstream specs can use: test.use({ storageState: '.auth-storage.json' })
   * The fixture generates this once per worker.
   */
  authStorageState: string;
}

/**
 * Resolve the API base URL from the test's context.
 * For the `hosted` project, the API is on a separate port.
 * For `self-hosted`, API and web share the same origin.
 */
function resolveApiUrl(_page: Page): string {
  // Prefer environment variables set by scripts/e2e.sh or CI
  const envApi = process.env.E2E_BASE_URL_API;
  if (envApi) return envApi;

  const envSelfHosted = process.env.E2E_BASE_URL_SELF_HOSTED;
  if (envSelfHosted) return envSelfHosted;

  // Fallback: derive from page URL origin
  const origin = new URL(_page.url()).origin;
  const project = _page.context()['_project']?.['name'];
  if (project === 'hosted') {
    return origin.replace(/:4002$/, ':4001');
  }
  return origin;
}

const DEFAULT_EMAIL = 'e2e@slugbase.test';
const DEFAULT_PASSWORD = 'e2e-test-password';

export const test = base.extend<E2eFixtures>({
  loginViaApi: async ({ page }, use) => {
    const apiUrl = resolveApiUrl(page);
    const email = process.env.E2E_TEST_EMAIL ?? DEFAULT_EMAIL;
    const password = process.env.E2E_TEST_PASSWORD ?? DEFAULT_PASSWORD;

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

  authStorageState: async ({ page, loginViaApi }, use) => {
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
    await page.context().storageState({ path: STORAGE_STATE_PATH });
    use(STORAGE_STATE_PATH);
  },
});

export { expect } from '@playwright/test';