import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const STORAGE_STATE_PATH = '.auth-storage.json';

export interface WorkerCredentials {
  email: string;
  password: string;
  name: string;
}

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

  /**
   * Worker-scoped email address for the current Playwright worker.
   */
  workerEmail: string;
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

// ── Worker credentials loading ────────────────────────────────────────────────

let _workerCredentials: WorkerCredentials[] | null = null;

/**
 * Load worker credentials written by global-setup.
 * Falls back to a single legacy credential if the file doesn't exist.
 */
function loadWorkerCredentials(): WorkerCredentials[] {
  if (_workerCredentials) return _workerCredentials;

  const credPath = resolve(process.cwd(), 'e2e', '.worker-credentials.json');
  if (existsSync(credPath)) {
    try {
      _workerCredentials = JSON.parse(
        readFileSync(credPath, 'utf-8'),
      ) as WorkerCredentials[];
      return _workerCredentials!;
    } catch {
      // Corrupted — fall through to legacy
    }
  }

  // Fallback: single legacy user (for self-hosted or when global-setup hasn't run)
  _workerCredentials = [
    { email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD, name: 'E2E Test User' },
  ];
  return _workerCredentials;
}

/**
 * Get credentials for a specific worker index.
 * Workers are assigned round-robin across the registered user pool.
 */
export function getWorkerCredentials(workerIndex: number): WorkerCredentials {
  const creds = loadWorkerCredentials();
  return creds[workerIndex % creds.length];
}

// ── Cookie parsing ────────────────────────────────────────────────────────────

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

// ── Per-worker login cache ────────────────────────────────────────────────────

interface LoginResult {
  cookies: Cookie[];
  cookieHeader: string;
  csrfToken: string;
}

const loginCacheByWorker = new Map<number, LoginResult>();

async function getLoginResult(workerIndex: number): Promise<LoginResult> {
  const cached = loginCacheByWorker.get(workerIndex);
  if (cached) return cached;

  const apiUrl = resolveApiUrl();
  const cred = getWorkerCredentials(workerIndex);

  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cred.email, password: cred.password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `API login failed for worker ${workerIndex} (${cred.email}): ${res.status} ${body}`,
    );
  }

  const rawCookies = res.headers.getSetCookie();
  if (rawCookies.length === 0) {
    throw new Error('Login succeeded but no Set-Cookie headers received');
  }

  const domain = resolveWebHostname();
  const cookies = rawCookies
    .map((h) => parseSetCookie(h, domain))
    .filter(Boolean) as Cookie[];

  // Fetch a CSRF token — the guard now enforces it in all modes.
  const csrfRes = await fetch(`${apiUrl}/auth/csrf-token`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  if (!csrfRes.ok) {
    throw new Error(`CSRF token fetch failed: ${csrfRes.status}`);
  }
  const csrfData = (await csrfRes.json()) as { csrfToken: string };

  // Append any Set-Cookie from the CSRF endpoint (e.g. csrf_token cookie)
  const csrfRawCookies = csrfRes.headers.getSetCookie();
  for (const h of csrfRawCookies) {
    const parsed = parseSetCookie(h, domain);
    if (parsed) cookies.push(parsed);
  }

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const result: LoginResult = { cookies, cookieHeader, csrfToken: csrfData.csrfToken };
  loginCacheByWorker.set(workerIndex, result);
  return result;
}

// ── Playwright test fixtures ──────────────────────────────────────────────────

export const test = base.extend<E2eFixtures>({
  workerEmail: async ({}, use, testInfo) => {
    const cred = getWorkerCredentials(testInfo.workerIndex);
    await use(cred.email);
  },

  sessionCookie: async ({}, use, testInfo) => {
    const { cookieHeader } = await getLoginResult(testInfo.workerIndex);
    await use(cookieHeader);
  },

  csrfToken: async ({}, use, testInfo) => {
    const { csrfToken } = await getLoginResult(testInfo.workerIndex);
    await use(csrfToken);
  },

  authedPage: async ({ page }, use, testInfo) => {
    const { cookies } = await getLoginResult(testInfo.workerIndex);
    expect(cookies.length, 'No cookies parsed from login response').toBeGreaterThan(0);
    await page.context().addCookies(cookies);
    await use(page);
  },

  authStorageState: async ({ page }, use, testInfo) => {
    const { cookies } = await getLoginResult(testInfo.workerIndex);
    expect(cookies.length, 'No cookies parsed from login response').toBeGreaterThan(0);
    await page.context().addCookies(cookies);
    await page.context().storageState({ path: STORAGE_STATE_PATH });
    use(STORAGE_STATE_PATH);
  },
});

export { expect } from '@playwright/test';
