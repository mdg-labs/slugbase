function readEnvString(key: string): string | undefined {
  const fromProcess =
    typeof process !== "undefined" ? process.env[key] : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) {
    return fromProcess;
  }

  if (typeof import.meta !== "undefined" && key in import.meta.env) {
    const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

/** Client-side API origin for browser fetch calls (hosted cross-origin vs same-origin). */
export function getApiBaseUrl(): string {
  const fromApiBase = readEnvString("API_BASE_URL");
  if (fromApiBase !== undefined) {
    return fromApiBase.replace(/\/$/, "");
  }

  const fromVite = readEnvString("VITE_API_URL");
  if (fromVite !== undefined) {
    return fromVite.replace(/\/$/, "");
  }

  return "";
}

/**
 * Resolves a NestJS API path for client-side fetch.
 * Same-origin (self-hosted): prefix with `/api` to hit the Worker proxy.
 * Cross-origin (hosted): use the path as-is on the NestJS API origin.
 */
export function resolveClientApiPath(apiPath: string): string {
  const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (getApiBaseUrl().length > 0) {
    return normalized;
  }
  return `/api${normalized}`;
}
