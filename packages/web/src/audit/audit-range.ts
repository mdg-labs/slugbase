import type { AuditRangePreset } from "./audit-search.ts";

const HOUR_MS = 3_600_000;

/** How far back each preset reaches. */
const PRESET_HOURS: Record<AuditRangePreset, number> = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24, "90d": 90 * 24 };

/** The range the log is asked for: a preset, or the first and last day (`YYYY-MM-DD`) of days in the viewer's time zone, either of which may be left open. */
export interface AuditRange {
  readonly preset?: AuditRangePreset;
  readonly firstDay?: string;
  readonly lastDay?: string;
}

/** The instants the API takes as `from` (inclusive) and `to` (exclusive); a bound that is not needed is left out. */
export interface AuditTimeBounds {
  readonly from?: string;
  readonly to?: string;
}

const MIN_INSTANT = "0001-01-01T00:00:00.000Z";

/** The start of a day of the calendar in the viewer's time zone. `offset` moves it by whole days, which stay calendar days across a change of the clock. */
export function startOfDay(day: string, offset: number): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  // `setFullYear` takes years 0 to 99 as they are; the constructor reads them as 1900 to 1999.
  const start = new Date(0);
  start.setFullYear(year, month - 1, date + offset);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** An instant as the API reads it, kept inside years 0001 to 9999: before that it is the first instant, after it there is no bound to send. */
function instant(date: Date): string | undefined {
  if (date.getUTCFullYear() > 9999) {
    return undefined;
  }
  return date.getUTCFullYear() < 1 ? MIN_INSTANT : date.toISOString();
}

/**
 * The bounds of a range as UTC instants. A preset reaches back from `now` and has no end. A range of days runs from the start of the first day to the start of the day
 * after the last, both in the viewer's time zone, so that the last day's events are in it.
 */
export function auditRangeBounds(range: AuditRange, now: Date): AuditTimeBounds {
  if (range.preset !== undefined) {
    const from = instant(new Date(now.getTime() - PRESET_HOURS[range.preset] * HOUR_MS));
    return from === undefined ? {} : { from };
  }
  const from = range.firstDay === undefined ? undefined : instant(startOfDay(range.firstDay, 0));
  const to = range.lastDay === undefined ? undefined : instant(startOfDay(range.lastDay, 1));
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}
