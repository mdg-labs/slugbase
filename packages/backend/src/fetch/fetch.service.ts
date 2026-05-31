import { lookup as dnsLookup } from "node:dns/promises";

import {
  FETCH_CACHE_TTL_MS,
  FETCH_MAX_RESPONSE_BYTES,
  FETCH_TIMEOUT_MS,
} from "./fetch.constants.js";
import {
  FetchBlockedError,
  FetchRequestError,
  FetchSizeLimitError,
  FetchTimeoutError,
} from "./fetch.errors.js";
import { FetchCache } from "./fetch-cache.js";
import type {
  FetchPort,
  FetchRequestOptions,
  FetchResponse,
} from "./fetch.interface.js";
import {
  assertPublicHost,
  parseAndValidateRequestUrl,
  type DnsLookupFn,
} from "./host-validation.js";

export type HttpExecutor = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface FetchServiceOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  cacheTtlMs?: number;
  lookup?: DnsLookupFn;
  httpExecutor?: HttpExecutor;
}

export class FetchService implements FetchPort {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly cache: FetchCache;
  private readonly lookup: DnsLookupFn;
  private readonly httpExecutor: HttpExecutor;

  constructor(options: FetchServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? FETCH_MAX_RESPONSE_BYTES;
    this.cache = new FetchCache(options.cacheTtlMs ?? FETCH_CACHE_TTL_MS);
    this.lookup =
      options.lookup ??
      (async (hostname) => {
        const records = await dnsLookup(hostname, { all: true, verbatim: true });
        return records.map((record) => ({
          address: record.address,
          family: record.family,
        }));
      });
    this.httpExecutor = options.httpExecutor ?? globalThis.fetch.bind(globalThis);
  }

  get(
    url: string,
    options?: Omit<FetchRequestOptions, "method">,
  ): Promise<FetchResponse> {
    return this.fetch(url, { ...options, method: "GET" });
  }

  async fetch(
    url: string,
    options: FetchRequestOptions = {},
  ): Promise<FetchResponse> {
    const method = options.method ?? "GET";
    const parsed = parseAndValidateRequestUrl(url);
    await assertPublicHost(parsed.hostname, this.lookup);

    const cacheKey = `${method}:${parsed.toString()}`;
    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.httpExecutor(parsed.toString(), {
        method,
        headers: options.headers,
        signal: controller.signal,
        redirect: "follow",
      });

      const body = await readBodyWithLimit(response, this.maxResponseBytes);
      const headers = headersToRecord(response.headers);
      const result: FetchResponse = {
        status: response.status,
        headers,
        body,
        url: response.url,
      };

      if (!options.skipCache && method === "GET" && response.ok) {
        this.cache.set(cacheKey, result);
      }

      return result;
    } catch (error) {
      if (
        error instanceof FetchBlockedError ||
        error instanceof FetchSizeLimitError
      ) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new FetchTimeoutError(
          `Request timed out after ${String(this.timeoutMs)}ms`,
        );
      }

      if (error instanceof Error) {
        throw new FetchRequestError(error.message);
      }

      throw new FetchRequestError("Outbound fetch failed");
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new FetchSizeLimitError(
        `Response exceeded maximum size of ${String(maxBytes)} bytes`,
      );
    }
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new FetchSizeLimitError(
      `Response exceeded maximum size of ${String(maxBytes)} bytes`,
    );
  }

  return new Uint8Array(buffer);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
