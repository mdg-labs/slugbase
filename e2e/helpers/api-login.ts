import { getWorkerCredentials } from '../fixtures/auth.js';

export interface ApiSession {
  sessionCookie: string;
  csrfToken: string;
  email: string;
  workerIndex: number;
}

function resolveApiUrl(): string {
  return process.env.E2E_BASE_URL_API
    ?? process.env.E2E_BASE_URL_CE
    ?? 'http://localhost:4001';
}

function resolveWebHostname(): string {
  const webUrl = process.env.E2E_BASE_URL_WEB
    ?? process.env.E2E_BASE_URL_CE
    ?? 'http://localhost:4002';
  return new URL(webUrl).hostname;
}

interface ParsedCookie {
  name: string;
  value: string;
}

function parseSetCookie(header: string): ParsedCookie | null {
  const nameValue = header.split(';')[0];
  if (!nameValue) return null;

  const eqIdx = nameValue.indexOf('=');
  if (eqIdx === -1) return null;

  return {
    name: nameValue.slice(0, eqIdx).trim(),
    value: nameValue.slice(eqIdx + 1).trim(),
  };
}

const sessionCache = new Map<number, ApiSession>();

/** API login for an arbitrary worker index (not tied to Playwright test fixtures). */
export async function loginWorkerApi(workerIndex: number): Promise<ApiSession> {
  const cached = sessionCache.get(workerIndex);
  if (cached) return cached;

  const cred = getWorkerCredentials(workerIndex);
  const apiUrl = resolveApiUrl();

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
    throw new Error(`Login succeeded but no Set-Cookie headers for worker ${workerIndex}`);
  }

  const cookies = rawCookies
    .map((header) => parseSetCookie(header))
    .filter(Boolean) as ParsedCookie[];

  const csrfRes = await fetch(`${apiUrl}/auth/csrf-token`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  if (!csrfRes.ok) {
    throw new Error(`CSRF token fetch failed for worker ${workerIndex}: ${csrfRes.status}`);
  }

  const csrfData = (await csrfRes.json()) as { csrfToken: string };
  for (const header of csrfRes.headers.getSetCookie()) {
    const parsed = parseSetCookie(header);
    if (parsed) cookies.push(parsed);
  }

  const session: ApiSession = {
    sessionCookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    csrfToken: csrfData.csrfToken,
    email: cred.email,
    workerIndex,
  };

  sessionCache.set(workerIndex, session);
  return session;
}

export function resolveE2eApiUrl(): string {
  return resolveApiUrl();
}

export function resolveE2eWebHostname(): string {
  return resolveWebHostname();
}
