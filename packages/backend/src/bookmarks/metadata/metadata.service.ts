import {
  BadRequestException,
  ForbiddenException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";

import {
  FetchBlockedError,
  FetchRequestError,
  FetchSizeLimitError,
  FetchTimeoutError,
} from "../../fetch/fetch.errors.js";
import type { FetchPort } from "../../fetch/fetch.interface.js";
import { FETCH } from "../../fetch/fetch.tokens.js";
import { parsePageMetadata, resolveFaviconUrl } from "./metadata-parser.js";
import type { FaviconPayload, PageMetadata } from "./metadata.types.js";

const METADATA_ACCEPT =
  "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";

@Injectable()
export class MetadataService {
  constructor(@Inject(FETCH) private readonly fetch: FetchPort) {}

  async fetchMetadata(rawUrl: string): Promise<PageMetadata> {
    const url = this.normalizeHttpUrl(rawUrl);
    const response = await this.safeFetch(url, {
      headers: { Accept: METADATA_ACCEPT },
    });

    if (!response.ok) {
      throw new NotFoundException("Page metadata could not be fetched");
    }

    const html = new TextDecoder().decode(response.body);
    return parsePageMetadata(html, response.url || url);
  }

  async fetchFavicon(rawUrl: string): Promise<FaviconPayload> {
    const pageUrl = this.normalizeHttpUrl(rawUrl);
    const pageResponse = await this.safeFetch(pageUrl, {
      headers: { Accept: METADATA_ACCEPT },
    });

    if (!pageResponse.ok) {
      throw new NotFoundException("Favicon source page could not be fetched");
    }

    const html = new TextDecoder().decode(pageResponse.body);
    const faviconUrl = resolveFaviconUrl(pageResponse.url || pageUrl, html);
    if (!faviconUrl) {
      throw new NotFoundException("Favicon URL could not be resolved");
    }

    const faviconResponse = await this.safeFetch(faviconUrl, {
      headers: { Accept: "image/*,*/*;q=0.8" },
    });

    if (!faviconResponse.ok) {
      throw new NotFoundException("Favicon could not be fetched");
    }

    return {
      body: faviconResponse.body,
      contentType:
        faviconResponse.headers["content-type"] ??
        faviconResponse.headers["Content-Type"] ??
        "application/octet-stream",
    };
  }

  private normalizeHttpUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException("URL is required");
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException("Invalid URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BadRequestException("Only http and https URLs are supported");
    }

    return parsed.toString();
  }

  private async safeFetch(
    url: string,
    options: { headers?: Readonly<Record<string, string>> } = {},
  ) {
    try {
      const response = await this.fetch.get(url, options);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        body: response.body,
        url: response.url,
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof FetchBlockedError) {
        throw new ForbiddenException("URL is not allowed");
      }
      if (error instanceof FetchTimeoutError) {
        throw new GatewayTimeoutException("Upstream request timed out");
      }
      if (error instanceof FetchSizeLimitError) {
        throw new PayloadTooLargeException("Upstream response too large");
      }
      if (error instanceof FetchRequestError) {
        throw new ServiceUnavailableException("Upstream request failed");
      }
      throw error;
    }
  }
}
