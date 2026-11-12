import type { Port } from "./port.ts";

export interface ErrorReportContext {
  readonly requestId?: string;
  readonly route?: string;
}

/** How a monitored run ended. */
export type MonitoredRunOutcome = "ok" | "error";

/** One run of a monitored job, from its start to its end (doc 01 section 6). */
export interface MonitoredRun {
  /** Reports the end of the run. It resolves when the report has been handed over or has failed, and never rejects. */
  finish(outcome: MonitoredRunOutcome): Promise<void>;
}

/** Captures exceptions with PII scrubbing (doc 01 section 6). */
export interface ErrorReportPort extends Port {
  capture(error: unknown, context?: ErrorReportContext): Promise<void>;
  /**
   * Reports the start of a run of the job that the monitor `slug` stands for and returns the run, which reports
   * its end. An adapter that does not monitor runs leaves this out, and a caller then reports nothing. It never
   * rejects: a report that fails is the adapter's to drop, and the job's outcome does not depend on it.
   */
  startMonitoredRun?(slug: string): Promise<MonitoredRun>;
}
