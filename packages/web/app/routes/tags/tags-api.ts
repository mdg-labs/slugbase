const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

async function getMutationHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${getApiBaseUrl()}/auth/csrf-token`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch CSRF token");
  }
  const data = (await res.json()) as { csrfToken: string };
  return {
    "Content-Type": "application/json",
    "x-csrf-token": data.csrfToken,
  };
}

export async function createTag(name: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/tags`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("failed");
}

export async function renameTag(id: string, name: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/tags/${id}`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("failed");
}

export async function deleteTag(id: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/tags/${id}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error("failed");
}
