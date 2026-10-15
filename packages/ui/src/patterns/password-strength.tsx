import type { ReactElement } from "react";
import { cn } from "../lib/utils.ts";

/** How strong a password is judged to be, from 0 (very weak) to 4 (strong). */
export type PasswordScore = 0 | 1 | 2 | 3 | 4;

const SEGMENTS = [1, 2, 3, 4] as const;

const BAR_COLOURS: Record<PasswordScore, string> = {
  0: "bg-destructive",
  1: "bg-destructive",
  2: "bg-warning",
  3: "bg-success",
  4: "bg-success",
};

export interface PasswordStrengthProps {
  score: PasswordScore;
  /** Names the meter. */
  label: string;
  /** The score in words, for example "Weak"; shown beside the bar and read by assistive technology. */
  scoreLabel: string;
  className?: string;
}

/**
 * The strength meter under a new-password field (doc 03 `secret-input`): four segments that fill as the
 * score rises, with the score in words. It only shows a score; the server's policy decides what is accepted.
 */
export function PasswordStrength({ score, label, scoreLabel, className }: PasswordStrengthProps): ReactElement {
  return (
    <div className={cn("flex items-center gap-3", className)} data-slot="password-strength">
      <div
        aria-label={label}
        aria-valuemax={4}
        aria-valuemin={0}
        aria-valuenow={score}
        aria-valuetext={scoreLabel}
        className="flex flex-1 gap-1"
        role="meter"
      >
        {SEGMENTS.map((segment) => (
          <span
            className={cn("h-1.5 flex-1 rounded-full bg-muted", score >= segment && BAR_COLOURS[score])}
            key={segment}
          />
        ))}
      </div>
      <span aria-hidden="true" className="w-16 text-muted-foreground text-xs">
        {scoreLabel}
      </span>
    </div>
  );
}
