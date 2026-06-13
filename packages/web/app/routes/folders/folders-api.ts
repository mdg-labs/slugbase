import { apiFetch } from "../../lib/client-api-fetch.js";

export interface FolderFormData {
  name: string;
  color?: string | null;
  icon?: string | null;
}

export async function createFolder(data: FolderFormData): Promise<void> {
  const res = await apiFetch("/folders", {
    method: "POST",
    csrf: true,
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("failed");
}

export async function renameFolder(
  id: string,
  data: FolderFormData,
): Promise<void> {
  const res = await apiFetch(`/folders/${id}`, {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("failed");
}

export async function deleteFolder(id: string): Promise<void> {
  const res = await apiFetch(`/folders/${id}`, { method: "DELETE", csrf: true });
  if (!res.ok) throw new Error("failed");
}
