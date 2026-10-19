import { useId, type ReactElement, type ReactNode } from "react";
import { RadioGroupPrimitive, RadioPrimitive } from "../components/ui/radio-group.tsx";
import { cn } from "../lib/utils.ts";

export interface ChoiceCardOption {
  value: string;
  label: ReactNode;
  /** What choosing the option means; the option is described by it. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface ChoiceCardsProps {
  /** Names the group for assistive technology and is shown above it. */
  label: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  /** Help shown under the group; the group is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the group is invalid and described by this message. */
  error?: ReactNode;
  options: readonly ChoiceCardOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Exactly one of a few options, each a card with a description (doc 03 `choice-cards`): a labelled radio group, so
 * the arrow keys move between the cards and a screen reader announces the position.
 */
export function ChoiceCards({ label, name, description, error, options, value, onValueChange, disabled, className }: ChoiceCardsProps): ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error !== null && error !== false;
  const describedBy = [description === undefined ? undefined : descriptionId, invalid ? errorId : undefined].filter((part) => part !== undefined).join(" ");
  const optionIds = options.map((option) => ({ label: `${id}-label-${option.value}`, description: `${id}-description-${option.value}` }));
  return (
    <div className={cn("flex flex-col items-stretch gap-1.5", className)}>
      <span className="font-medium text-base/4.5 text-foreground sm:text-sm/4" id={labelId}>
        {label}
      </span>
      <RadioGroupPrimitive
        aria-describedby={describedBy === "" ? undefined : describedBy}
        aria-invalid={invalid ? true : undefined}
        aria-labelledby={labelId}
        className="flex flex-col gap-2"
        data-slot="choice-cards"
        disabled={disabled}
        name={name}
        onValueChange={(next) => {
          if (typeof next === "string") {
            onValueChange(next);
          }
        }}
        value={value}
      >
        {options.map((option, index) => {
          const optionLabelId = optionIds[index]?.label;
          const optionDescriptionId = optionIds[index]?.description;
          return (
            <RadioPrimitive.Root
              aria-describedby={option.description === undefined ? undefined : optionDescriptionId}
              aria-labelledby={optionLabelId}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-input bg-background p-3 text-start outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-checked:border-primary data-checked:bg-accent/50 data-disabled:cursor-not-allowed data-disabled:opacity-64"
              data-slot="choice-card"
              disabled={option.disabled}
              key={option.value}
              value={option.value}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background"
              >
                <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" data-slot="choice-card-indicator" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-foreground text-sm" id={optionLabelId}>
                  {option.label}
                </span>
                {option.description === undefined ? null : (
                  <span className="text-muted-foreground text-xs" id={optionDescriptionId}>
                    {option.description}
                  </span>
                )}
              </span>
            </RadioPrimitive.Root>
          );
        })}
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
