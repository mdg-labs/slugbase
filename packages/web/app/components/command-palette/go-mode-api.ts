export interface GoCandidate {
  id: string;
  title: string;
  url: string;
  ownerUserId: string;
}

export interface GoDisambiguationData {
  kind: "disambiguation";
  slug: string;
  candidates: GoCandidate[];
}

export interface GoRedirectData {
  kind: "redirect";
  url: string;
  bookmarkId: string;
}

export type GoResolveData = GoDisambiguationData | GoRedirectData;

export async function resolveGoSlugJson(slug: string): Promise<GoResolveData> {
  const res = await fetch(`/api/go/${encodeURIComponent(slug)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Go resolve failed: ${String(res.status)}`);
  }
  return (await res.json()) as GoResolveData;
}

async function getCsrfToken(): Promise<string> {
  const res = await fetch("/auth/csrf-token", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch CSRF token");
  const data = (await res.json()) as { csrfToken: string };
  return data.csrfToken;
}

export async function chooseGoSlug(
  slug: string,
  bookmarkId: string,
  remember: boolean,
): Promise<void> {
  const csrfToken = await getCsrfToken();
  await fetch(`/api/go/${encodeURIComponent(slug)}/choose`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ bookmarkId, remember }),
  });
}
