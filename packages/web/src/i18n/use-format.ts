import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_LOCALE } from "./locales.ts";

export interface Format {
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** "2 hr. ago", "in 3 days", "yesterday": the largest unit that fits, in the language. */
  relativeTime(value: Date | number, now?: Date | number): string;
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function createFormat(language: string): Format {
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  return {
    date: (value, options) => new Intl.DateTimeFormat(language, options).format(value),
    number: (value, options) => new Intl.NumberFormat(language, options).format(value),
    relativeTime: (value, now = Date.now()) => {
      const seconds = (new Date(value).getTime() - new Date(now).getTime()) / 1000;
      const [unit, size] = UNITS.find(([, span]) => Math.abs(seconds) >= span) ?? (["second", 1] as const);
      return relative.format(Math.round(seconds / size), unit);
    },
  };
}

/** Formats dates, numbers and relative times with `Intl` in the active language. */
export function useFormat(): Format {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? DEFAULT_LOCALE;
  return useMemo(() => createFormat(language), [language]);
}
