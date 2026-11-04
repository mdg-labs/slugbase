import { useState, type ReactElement, type ReactNode } from "react";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { FormField } from "./form-field.tsx";
import { SelectField, type SelectOption } from "./select-field.tsx";

/** The first day a date range takes, as a native date input writes it. */
export const DATE_RANGE_MIN_DAY = "0001-01-01";

/** The last day a date range takes. */
export const DATE_RANGE_MAX_DAY = "9999-12-31";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Whether the text is a day of the calendar written `YYYY-MM-DD`, from year 0001 to 9999. */
export function isCalendarDay(value: string): boolean {
  const parts = DAY.exec(value);
  if (parts === null) {
    return false;
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const length = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day <= length;
}

/** The days of a custom range, each empty or a day `YYYY-MM-DD`; an empty one leaves that end open. */
export interface DateRangeDays {
  first: string;
  last: string;
}

export interface DateRangeProps {
  /** Names the preset select. */
  label: ReactNode;
  /** The presets, with the option that means no range and the one that means a range of days. */
  presets: readonly SelectOption[];
  /** The `value` of the chosen preset. */
  preset: string;
  onPresetChange: (preset: string) => void;
  /** The `value` of the preset whose days are entered; the two day fields show only while it is chosen. */
  customPreset: string;
  firstLabel: ReactNode;
  lastLabel: ReactNode;
  /** The days as they are held. */
  days: DateRangeDays;
  /** Called with the days when they pass: each empty or a day from year 0001 to 9999, and the first not after the last. Nothing is called while they do not. */
  onDaysChange: (days: DateRangeDays) => void;
  /** Said under the last day while the first day is after it. */
  orderError: ReactNode;
  /** Said under a day that is no day of the calendar or lies outside years 0001 to 9999. */
  boundsError: ReactNode;
  /** Why the days as held are refused elsewhere, such as by the server; said under the last day while the days are not edited. */
  error?: ReactNode;
  disabled?: boolean;
  className?: string;
}

function boundsRefused(value: string): boolean {
  return value !== "" && !isCalendarDay(value);
}

/**
 * A date range (doc 03 `date-range`): a select of presets and, for the custom one, two native date inputs for the first and last day. The inputs are keyboard operable and
 * localised by the browser. A range the member cannot mean, a first day after the last or a day outside years 0001 to 9999, says so under the field and is not reported.
 */
export function DateRange({
  label,
  presets,
  preset,
  onPresetChange,
  customPreset,
  firstLabel,
  lastLabel,
  days,
  onDaysChange,
  orderError,
  boundsError,
  error,
  disabled,
  className,
}: DateRangeProps): ReactElement {
  // What is typed is kept here while it is refused, so the field keeps the text; the days held by the caller replace it whenever they change.
  const [draft, setDraft] = useState(days);
  const [held, setHeld] = useState(days);
  if (held.first !== days.first || held.last !== days.last) {
    setHeld(days);
    setDraft(days);
  }

  function edit(next: DateRangeDays): void {
    setDraft(next);
    if (boundsRefused(next.first) || boundsRefused(next.last) || (next.first !== "" && next.last !== "" && next.first > next.last)) {
      return;
    }
    onDaysChange(next);
  }

  const firstError = boundsRefused(draft.first) ? boundsError : undefined;
  const lastError = boundsRefused(draft.last)
    ? boundsError
    : draft.first !== "" && draft.last !== "" && draft.first > draft.last
      ? orderError
      : draft.first === days.first && draft.last === days.last
        ? error
        : undefined;

  return (
    <div className={cn("grid items-start gap-3 sm:grid-cols-3", className)}>
      <SelectField disabled={disabled} label={label} onValueChange={onPresetChange} options={presets} value={preset} />
      {preset === customPreset ? (
        <>
          <FormField error={firstError} label={firstLabel}>
            <Input
              disabled={disabled}
              max={DATE_RANGE_MAX_DAY}
              min={DATE_RANGE_MIN_DAY}
              onChange={(event) => {
                edit({ first: event.target.value, last: draft.last });
              }}
              type="date"
              value={draft.first}
            />
          </FormField>
          <FormField error={lastError} label={lastLabel}>
            <Input
              disabled={disabled}
              max={DATE_RANGE_MAX_DAY}
              min={DATE_RANGE_MIN_DAY}
              onChange={(event) => {
                edit({ first: draft.first, last: event.target.value });
              }}
              type="date"
              value={draft.last}
            />
          </FormField>
        </>
      ) : null}
    </div>
  );
}
