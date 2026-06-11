const getApiBaseUrl = (): string => {
  if (typeof process !== "undefined" && process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }
  if (typeof import.meta !== "undefined") {
    const viteUrl = import.meta.env.VITE_API_URL as string | undefined;
    if (viteUrl) return viteUrl;
  }
  return "";
};

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

export interface FolderFormData {
  name: string;
  color?: string | null;
  icon?: string | null;
}

export async function createFolder(data: FolderFormData): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/folders`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("failed");
}

export async function renameFolder(
  id: string,
  data: FolderFormData,
): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/folders/${id}`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("failed");
}

export async function deleteFolder(id: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/folders/${id}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error("failed");
}
