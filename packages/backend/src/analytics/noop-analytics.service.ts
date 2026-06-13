import { Injectable } from "@nestjs/common";
import type {
  AnalyticsEventContext,
  AnalyticsService,
} from "@slugbase/shared-types";

/**
 * No-op product analytics - used when Umami is not configured (spec §11.6).
 */
@Injectable()
export class NoopAnalyticsService implements AnalyticsService {
  isConfigured(): boolean {
    return false;
  }

  recordEvent(_name: string, _context?: AnalyticsEventContext): void {
    // intentionally empty
  }
}
