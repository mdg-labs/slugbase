import type { ReactElement } from "react";
import { Progress, ProgressIndicator, ProgressTrack } from "../components/ui/progress.tsx";
import { cn } from "../lib/utils.ts";

export interface UsageMeterProps {
  /** What the bar measures; it names the bar for assistive technology. */
  label: string;
  /** The amount shown by the filled part of the bar. */
  value: number;
  /** The amount a full bar stands for. */
  max: number;
  /** The amount as the page writes it in the language of the member ("12 bookmarks"); it is shown above the bar and read out with it. */
  valueLabel: string;
  className?: string;
}

/** A measure against a whole (doc 03 `usage-meter`): the formatted amount and a bar filled to its share of `max`. */
export function UsageMeter({ label, value, max, valueLabel, className }: UsageMeterProps): ReactElement {
  return (
    <Progress aria-label={label} className={cn("gap-1", className)} getAriaValueText={() => valueLabel} max={max} value={Math.min(value, max)}>
      <span className="text-sm tabular-nums">{valueLabel}</span>
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </Progress>
  );
}
