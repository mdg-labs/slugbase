async function getCsrfToken(): Promise<string> {
  const res = await fetch("/auth/csrf-token", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch CSRF token");
  const data = (await res.json()) as { csrfToken: string };
  return data.csrfToken;
}

/** Matches backend `ImportResultSchema` (shared-types import contract). */
export interface ImportResult {
  total: number;
  successCount: number;
  failureCount: number;
  skippedSlugCount: number;
  capLimitedCount: number;
}

export async function importNetscapeHtml(html: string): Promise<ImportResult> {
  const csrfToken = await getCsrfToken();
  const res = await fetch("/api/import/netscape-html", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ html }),
  });
  if (!res.ok) {
    throw new Error(`Import failed: ${String(res.status)}`);
  }
  return (await res.json()) as ImportResult;
}

export async function importJson(payload: unknown): Promise<ImportResult> {
  const csrfToken = await getCsrfToken();
  const res = await fetch("/api/import/json", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Import failed: ${String(res.status)}`);
  }
  return (await res.json()) as ImportResult;
}

export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(reader.result as string); };
    reader.onerror = () => { reject(new Error("File read error")); };
    reader.readAsText(file);
  });
}

export function detectFileType(file: File): "netscape-html" | "json" | "unknown" {
  if (file.name.endsWith(".html") || file.name.endsWith(".htm")) {
    return "netscape-html";
  }
  if (file.name.endsWith(".json")) {
    return "json";
  }
  if (file.type === "text/html") return "netscape-html";
  if (file.type === "application/json") return "json";
  return "unknown";
}
