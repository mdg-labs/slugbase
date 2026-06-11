import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AnalyticsEventContext,
  AnalyticsService,
} from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";
import { shouldRecordAnalyticsEvent } from "./analytics-consent.js";
import { UMAMI_HTTP } from "./analytics.tokens.js";

export type UmamiHttpExecutor = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface UmamiSendPayload {
  type: "event";
  payload: {
    website: string;
    hostname: string;
    url: string;
    name: string;
    data?: Record<string, string | number | boolean>;
  };
}

/**
 * Umami-backed product analytics - active when UMAMI_HOST and UMAMI_WEBSITE_ID
 * are configured. Consent is enforced before events leave the process.
 */
@Injectable()
export class UmamiAnalyticsService implements AnalyticsService {
  private readonly logger = new Logger(UmamiAnalyticsService.name);

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(UMAMI_HTTP) private readonly http: UmamiHttpExecutor,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.get("UMAMI_HOST") && this.config.get("UMAMI_WEBSITE_ID"));
  }

  recordEvent(name: string, context?: AnalyticsEventContext): void {
    if (!shouldRecordAnalyticsEvent(this.isConfigured(), context)) {
      return;
    }

    const host = this.config.get("UMAMI_HOST");
    const websiteId = this.config.get("UMAMI_WEBSITE_ID");
    if (!host || !websiteId) {
      return;
    }

    const payload: UmamiSendPayload = {
      type: "event",
      payload: {
        website: websiteId,
        hostname: context?.hostname ?? new URL(this.config.get("APP_BASE_URL")).hostname,
        url: context?.url ?? "/",
        name,
        ...(context?.data ? { data: context.data } : {}),
      },
    };

    const endpoint = `${host.replace(/\/$/, "")}/api/send`;
    void this.sendEvent(endpoint, payload);
  }

  private async sendEvent(endpoint: string, payload: UmamiSendPayload): Promise<void> {
    try {
      const response = await this.http(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "SlugBase/1.0",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        this.logger.debug("Umami event rejected", { status: response.status });
      }
    } catch (error) {
      this.logger.debug("Umami event send failed", {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
