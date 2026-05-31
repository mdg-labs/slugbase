import type { FetchResponse } from "./fetch.interface.js";

interface CacheEntry {
  expiresAt: number;
  response: FetchResponse;
}

export class FetchCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, now = Date.now()): FetchResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    return cloneResponse(entry.response);
  }

  set(key: string, response: FetchResponse, now = Date.now()): void {
    this.entries.set(key, {
      expiresAt: now + this.ttlMs,
      response: cloneResponse(response),
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

function cloneResponse(response: FetchResponse): FetchResponse {
  return {
    status: response.status,
    headers: { ...response.headers },
    body: response.body.slice(),
    url: response.url,
  };
}
