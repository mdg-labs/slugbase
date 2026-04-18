/**
 * GET /api/csrf-token then return headers for a state-changing request (Cookie + x-csrf-token).
 */

export async function getCsrfAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/api/csrf-token`);
  if (!res.ok) {
    throw new Error(`csrf-token failed: ${res.status}`);
  }
  const data = (await res.json()) as { csrfToken: string };
  const rawSet = res.headers.get('set-cookie');
  const cookiePair = rawSet?.split(';')[0]?.trim() ?? '';
  return {
    Cookie: cookiePair,
    'x-csrf-token': data.csrfToken,
  };
}
