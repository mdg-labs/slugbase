import { test as base, expect, type Page } from '@playwright/test';

const STORAGE_STATE_PATH = '.auth-storage.json';

export interface E2eFixtures {
  /**
   * Pre-authenticated page — session cookie injected into browser context.
   */
  authedPage: Page;

  /**
   * Raw cookie header string (e.g. "slb_session=xxx").
   * Pass as { headers: { Cookie: sessionCookie } } in page.request calls
   * because page.request doesn't share browser cookies.
   */
  sessionCookie: string;

  /**
   * Pre-authenticated storage state file created via API login.
   */
  authStorageState: string;
}

function resolveApiUrl(): string {
  return process.env.E2E_BASE_URL_API
    ?? process.env.E2E_BASE_URL_SELF_HOSTED
    ?? 'http://localhost:4001';
}

function resolveWebHostname(): string {
  const webUrl = process.env.E2E_BASE_URL_WEB
    ?? process.env.E2E_BASE_URL_SELF_HOSTED
    ?? 'http://localhost:4002';
  return new URL(webUrl).hostname;
}

const DEFAULT_EMAIL = 'e2e@slugbase.test';
const DEFAULT_PASSWORD = 'e2e-test-password';

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
}

function parseSetCookie(header: string, domain: string): Cookie | null {
  const parts = header.split(';');
  const nameValue = parts[0];
  if (!nameValue) return null;

  const eqIdx = nameValue.indexOf('=');
  if (eqIdx === -1) return null;

  let path = '/';
  let httpOnly = false;
  let secure = false;
  let sameSite: 'Lax' | 'Strict' | 'None' = 'Lax';

  for (const part of parts.slice(1)) {
    const t = part.trim();
    const lo = t.toLowerCase();
    if (lo === 'httponly') httpOnly = true;
    else if (lo === 'secure') secure = true;
    else if (lo.startsWith('path=')) path = t.slice(5).trim() || '/';
    else if (lo.startsWith('samesite=')) {
      const v = t.slice(9).trim();
      if (v === 'Strict') sameSite = 'Strict';
      else if (v === 'None') sameSite = 'None';
      else sameSite = 'Lax';
    }
  }

  return {
    name: nameValue.slice(0, eqIdx).trim(),
    value: nameValue.slice(eqIdx + 1).trim(),
    domain,
    path,
    httpOnly,
    secure,
    sameSite,
  };
}

interface LoginResult {
  cookies: Cookie[];
  cookieHeader: string;
}

/**
 * Shared in-memory cache — both sessionCookie and authedPage fixtures
 * share the same login result, avoiding redundant API calls.
 */
let loginCache: LoginResult | null = null;

async function getLoginResult(): Promise<LoginResult> {
  if (loginCache) return loginCache;

  const apiUrl = resolveApiUrl();
  const email = process.env.E2E_TEST_EMAIL ?? DEFAULT_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD ?? DEFAULT_PASSWORD;

  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API login failed: ${res.status} ${body}`);
  }

  const rawCookies = res.headers.getSetCookie();
  if (rawCookies.length === 0) {
    throw new Error('Login succeeded but no Set-Cookie headers received');
  }

  const domain = resolveWebHostname();
  const cookies = rawCookies
    .map((h) => parseSetCookie(h, domain))
    .filter(Boolean) as Cookie[];

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  loginCache = { cookies, cookieHeader };
  return loginCache;
}

export const test = base.extend<E2eFixtures>({
  sessionCookie: async ({}, use) => {
    const { cookieHeader } = await getLoginResult();
    await use(cookieHeader);
  },

  authedPage: async ({ page }, use) => {
    const { cookies } = await getLoginResult();
    expect(cookies.length, 'No cookies parsed from login response').toBeGreaterThan(0);
    await page.context().addCookies(cookies);
    await use(page);
  },

  authStorageState: async ({ page }, use) => {
    const { cookies } = await getLoginResult();
    expect(cookies.length, 'No cookies parsed from login response').toBeGreaterThan(0);
    await page.context().addCookies(cookies);
    await page.context().storageState({ path: STORAGE_STATE_PATH });
    use(STORAGE_STATE_PATH);
  },
});

export { expect } from '@playwright/test';
