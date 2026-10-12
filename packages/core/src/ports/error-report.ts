import type { Port } from "./port.ts";

export interface ErrorReportContext {
  readonly requestId?: string;
  readonly route?: string;
}

/** Captures exceptions with PII scrubbing (doc 01 section 6). */
export interface ErrorReportPort extends Port {
  capture(error: unknown, context?: ErrorReportContext): Promise<void>;
}
