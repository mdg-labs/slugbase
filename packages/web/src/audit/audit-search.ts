import { AUDIT_EVENT_CATEGORIES } from "@slugbase/contracts";
import { isCalendarDay } from "@slugbase/ui/patterns";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

export type AuditCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

/** The presets of the date range: the events of the last 24 hours, 7, 30 or 90 days. */
export const AUDIT_RANGE_PRESETS = ["24h", "7d", "30d", "90d"] as const;

export type AuditRangePreset = (typeof AUDIT_RANGE_PRESETS)[number];

// The identifiers the API accepts: versions 1 to 8, or the nil and max values. Anything else would be refused with 422.
const IDENTIFIER = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

/**
 * What the address of `/settings/workspace/audit` says about the log (doc 03 sections 3.1 and 11.9). Every parameter is optional, so the plain address is the
 * whole log. The address has no page number: the log loads further events with a button (keyset pagination).
 */
export interface AuditSearch {
  /** Only events made by this account, by identifier. */
  actor?: string;
  /** Only events of these groups of actions (any of them), in the order they were chosen. */
  category?: readonly AuditCategory[];
  /** Only events of the last 24 hours, 7, 30 or 90 days. A preset takes the place of `from` and `to`. */
  range?: AuditRangePreset;
  /** Only events from the start of this day, `YYYY-MM-DD`, in the viewer's time zone. */
  from?: string;
  /** Only events up to the end of this day, `YYYY-MM-DD`, in the viewer's time zone. */
  to?: string;
}

/** Whether the value names one of the groups of actions. */
export function isAuditCategory(value: unknown): value is AuditCategory {
  return (AUDIT_EVENT_CATEGORIES as readonly unknown[]).includes(value);
}

function isAuditRangePreset(value: unknown): value is AuditRangePreset {
  return (AUDIT_RANGE_PRESETS as readonly unknown[]).includes(value);
}

function categoriesOf(value: unknown): readonly AuditCategory[] {
  // One category arrives as a bare string and several as a list; a value that names no category is dropped, a repeat counts once.
  const entries: readonly unknown[] = Array.isArray(value) ? (value as readonly unknown[]) : [value];
  return [...new Set(entries.filter(isAuditCategory))];
}

/** Reads the log's parameters out of an address's search; a value that is none of the allowed ones is dropped, never an error. */
export function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  const result: AuditSearch = {};
  if (typeof search["actor"] === "string" && IDENTIFIER.test(search["actor"])) {
    result.actor = search["actor"];
  }
  const category = categoriesOf(search["category"]);
  if (category.length > 0) {
    result.category = category;
  }
  if (isAuditRangePreset(search["range"])) {
    result.range = search["range"];
    return result;
  }
  const from = typeof search["from"] === "string" && isCalendarDay(search["from"]) ? search["from"] : undefined;
  const to = typeof search["to"] === "string" && isCalendarDay(search["to"]) ? search["to"] : undefined;
  // A range that ends before it starts is no range the log can be asked for.
  if (from !== undefined && to !== undefined && from > to) {
    return result;
  }
  if (from !== undefined) {
    result.from = from;
  }
  if (to !== undefined) {
    result.to = to;
  }
  return result;
}

/** Whether any filter narrows the log. */
export function hasActiveFilters(search: AuditSearch): boolean {
  return search.actor !== undefined || (search.category?.length ?? 0) > 0 || search.range !== undefined || search.from !== undefined || search.to !== undefined;
}

/**
 * The log's parameters of the current address, read again through the validation: the router lays the validated parameters over the raw ones and keeps a raw
 * value the validation dropped, so the page reads the validated ones from here rather than from the router's search.
 */
export function useAuditSearch(): AuditSearch {
  const raw = useSearch({ from: "/_app/settings/workspace/audit" });
  return validateAuditSearch(raw);
}

export interface AuditSearchControls {
  /** Changes the filters, as a navigation: back returns to the log as it was. A key set to `undefined` is removed. */
  readonly update: (changes: { readonly [Key in keyof AuditSearch]: AuditSearch[Key] | undefined }) => void;
  /** Removes every filter. */
  readonly clearFilters: () => void;
}

export function useAuditSearchControls(): AuditSearchControls {
  const navigate = useNavigate();
  return useMemo(() => {
    function go(change: (previous: Record<string, unknown>) => Record<string, unknown>): void {
      void navigate({ to: ".", search: (previous) => change(previous) });
    }
    return {
      update: (changes) => {
        go((previous) => {
          const next: Record<string, unknown> = { ...previous, ...changes };
          const entries: [string, unknown][] = Object.entries(changes);
          for (const [key, value] of entries) {
            if (value === undefined || (Array.isArray(value) && value.length === 0)) {
              Reflect.deleteProperty(next, key);
            }
          }
          return next;
        });
      },
      clearFilters: () => {
        go((previous) => {
          const next = { ...previous };
          for (const key of ["actor", "category", "range", "from", "to"]) {
            Reflect.deleteProperty(next, key);
          }
          return next;
        });
      },
    };
  }, [navigate]);
}
