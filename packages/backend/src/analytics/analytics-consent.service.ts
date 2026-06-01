import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";
import { DbService } from "../db/db.service.js";
import { SessionService } from "../sessions/session.service.js";
import { AnalyticsConsentRepository } from "./analytics-consent.repository.js";

export const ANALYTICS_CONSENT_COOKIE = "slugbase_analytics_cid";
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface AnalyticsPublicConfig {
  enabled: boolean;
}

export interface AnalyticsConsentStatus {
  decided: boolean;
  granted: boolean | null;
}

@Injectable()
export class AnalyticsConsentService {
  private readonly consentRepository: AnalyticsConsentRepository;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DbService) db: DbService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {
    this.consentRepository = new AnalyticsConsentRepository(
      db.getOrm(),
      db.dialect,
    );
  }

  getPublicConfig(): AnalyticsPublicConfig {
    return {
      enabled: Boolean(
        this.config.get("UMAMI_HOST") && this.config.get("UMAMI_WEBSITE_ID"),
      ),
    };
  }

  isProduction(): boolean {
    return this.config.get("isProduction");
  }

  resolveClientId(existingCookie?: string): string {
    if (existingCookie && existingCookie.trim().length > 0) {
      return existingCookie.trim();
    }
    return randomUUID();
  }

  async getConsentStatus(
    clientId: string,
    userId?: string | null,
  ): Promise<AnalyticsConsentStatus> {
    const record = await this.consentRepository.findByClientOrUser(clientId, userId);
    if (!record) {
      return { decided: false, granted: null };
    }
    return { decided: true, granted: record.granted };
  }

  async saveConsent(
    clientId: string,
    granted: boolean,
    userId?: string | null,
  ): Promise<AnalyticsConsentStatus> {
    await this.consentRepository.upsert({
      clientId,
      userId,
      granted,
    });
    return { decided: true, granted };
  }

  async resolveOptionalUserId(sessionCookie?: string): Promise<string | null> {
    if (!sessionCookie) {
      return null;
    }
    const sessionId = this.sessions.verifySessionCookie(sessionCookie);
    if (!sessionId) {
      return null;
    }
    const session = await this.sessions.findSession(sessionId);
    return session?.userId ?? null;
  }
}
