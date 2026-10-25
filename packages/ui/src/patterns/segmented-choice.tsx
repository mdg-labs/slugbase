import { useId, type ReactElement, type ReactNode } from "react";
import { RadioGroupPrimitive, RadioPrimitive } from "../components/ui/radio-group.tsx";
import { cn } from "../lib/utils.ts";

export interface SegmentedChoiceOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedChoiceProps {
  /** Names the group for assistive technology and is shown above it. */
  label: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  /** Help shown under the group; the group is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the group is invalid and described by this message. */
  error?: ReactNode;
  options: readonly SegmentedChoiceOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  /**
   * Draws only the icons of the options and keeps their labels for assistive technology and as the hint of the pointer, for
   * a set that is too wide for its labels, such as the eight folder colours. Every option needs an icon then.
   */
  iconOnly?: boolean;
}

/**
 * Exactly one of a few options, shown as joined segments: a labelled radio group, so the arrow keys move
 * between the options and a screen reader announces the position (doc 03 `segmented-choice`).
 */
export function SegmentedChoice({ label, name, description, error, options, value, onValueChange, disabled, className, iconOnly = false }: SegmentedChoiceProps): ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error !== null && error !== false;
  const describedBy = [description === undefined ? undefined : descriptionId, invalid ? errorId : undefined].filter((part) => part !== undefined).join(" ");
  return (
    <div className={cn("flex flex-col items-stretch gap-1.5", className)}>
      <span className="font-medium text-base/4.5 text-foreground sm:text-sm/4" id={labelId}>
        {label}
      </span>
      <RadioGroupPrimitive
        aria-describedby={describedBy === "" ? undefined : describedBy}
        aria-invalid={invalid ? true : undefined}
        aria-labelledby={labelId}
        className={cn("inline-flex w-fit max-w-full flex-row gap-0.5 rounded-lg border bg-muted p-0.5 data-disabled:opacity-64", iconOnly && "flex-wrap")}
        data-slot="segmented-choice"
        disabled={disabled}
        name={name}
        onValueChange={(next) => {
          if (typeof next === "string") {
            onValueChange(next);
          }
        }}
        value={value}
      >
        {options.map((option) => (
          <RadioPrimitive.Root
            className={cn(
              "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-background data-checked:text-foreground data-checked:shadow-sm data-disabled:cursor-not-allowed",
              iconOnly ? "w-8" : "px-3",
            )}
            data-slot="segmented-choice-option"
            key={option.value}
            title={iconOnly ? option.label : undefined}
            value={option.value}
          >
            {option.icon}
            {iconOnly ? <span className="sr-only">{option.label}</span> : option.label}
          </RadioPrimitive.Root>
        ))}
      </RadioGroupPrimitive>
      {description === undefined ? null : (
        <p className="text-muted-foreground text-xs" id={descriptionId}>
          {description}
        </p>
      )}
      {invalid ? (
        <p className="text-destructive-text text-xs" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
