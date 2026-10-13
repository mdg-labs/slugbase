import { ApiProblemError, type ApiClient } from "../api/client.ts";
import type { ApiConfig } from "./config-context.tsx";

export const CONFIG_TIMEOUT_MS = 10_000;

export type ConfigResult =
  | { readonly status: "ready"; readonly config: ApiConfig }
  | { readonly status: "failed"; readonly requestId?: string };

/**
 * Fetches `/api/config` once. It never rejects: a problem response, a network
 * failure, a timeout and an unreadable answer all come back as `failed`, carrying
 * the request id when the server sent one and nothing else of the cause.
 */
export async function fetchConfig(api: ApiClient): Promise<ConfigResult> {
  try {
    const { data } = await api.GET("/api/config", { signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) });
    return data === undefined ? { status: "failed" } : { status: "ready", config: data };
  } catch (error) {
    return error instanceof ApiProblemError ? { status: "failed", requestId: error.requestId } : { status: "failed" };
  }
}
