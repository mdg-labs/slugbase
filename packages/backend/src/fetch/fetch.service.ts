import { lookup as dnsLookup } from "node:dns/promises";

import {
  FETCH_CACHE_TTL_MS,
  FETCH_MAX_REDIRECTS,
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
  maxRedirects?: number;
  cacheTtlMs?: number;
  lookup?: DnsLookupFn;
  httpExecutor?: HttpExecutor;
}

export class FetchService implements FetchPort {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly cache: FetchCache;
  private readonly lookup: DnsLookupFn;
  private readonly httpExecutor: HttpExecutor;

  constructor(options: FetchServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? FETCH_MAX_RESPONSE_BYTES;
    this.maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
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
      const { response, finalUrl } = await fetchWithValidatedRedirects({
        initialUrl: parsed,
        method,
        headers: options.headers,
        lookup: this.lookup,
        httpExecutor: this.httpExecutor,
        maxRedirects: this.maxRedirects,
        signal: controller.signal,
      });

      const body = await readBodyWithLimit(response, this.maxResponseBytes);
      const headers = headersToRecord(response.headers);
      const result: FetchResponse = {
        status: response.status,
        headers,
        body,
        url: finalUrl,
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

interface FetchWithValidatedRedirectsParams {
  initialUrl: URL;
  method: FetchRequestOptions["method"];
  headers: FetchRequestOptions["headers"];
  lookup: DnsLookupFn;
  httpExecutor: HttpExecutor;
  maxRedirects: number;
  signal: AbortSignal;
}

async function fetchWithValidatedRedirects(
  params: FetchWithValidatedRedirectsParams,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = params.initialUrl;
  let currentMethod = params.method ?? "GET";
  let currentHeaders = params.headers;

  for (let hop = 0; hop <= params.maxRedirects; hop += 1) {
    await assertPublicHost(currentUrl.hostname, params.lookup);

    const response = await params.httpExecutor(currentUrl.toString(), {
      method: currentMethod,
      headers: currentHeaders,
      signal: params.signal,
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl.toString() };
    }

    if (hop >= params.maxRedirects) {
      throw new FetchRequestError("Too many redirects");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new FetchRequestError("Redirect response missing Location header");
    }

    currentUrl = resolveRedirectUrl(location, currentUrl);
    currentMethod = redirectMethodForStatus(response.status, currentMethod);
    currentHeaders = undefined;
  }

  throw new FetchRequestError("Too many redirects");
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function redirectMethodForStatus(
  status: number,
  method: NonNullable<FetchRequestOptions["method"]>,
): NonNullable<FetchRequestOptions["method"]> {
  if (status === 303 || (status !== 307 && status !== 308)) {
    return "GET";
  }

  return method;
}

function resolveRedirectUrl(location: string, baseUrl: URL): URL {
  return parseAndValidateRequestUrl(new URL(location, baseUrl).toString());
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
