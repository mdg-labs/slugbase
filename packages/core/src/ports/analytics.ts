import type { Port } from "./port.ts";

export interface AnalyticsEvent {
  readonly name: string;
  /** Whether the subject consented; an adapter records nothing without it. */
  readonly consent: boolean;
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
}

/** Consent-gated product events (doc 01 section 6). */
export interface AnalyticsPort extends Port {
  track(event: AnalyticsEvent): Promise<void>;
}
