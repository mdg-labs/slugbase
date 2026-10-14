import { CheckIcon } from "lucide-react";
import { useId, type ReactElement, type ReactNode } from "react";
import { RadioGroupPrimitive, RadioPrimitive } from "../components/ui/radio-group.tsx";
import { cn } from "../lib/utils.ts";
import { ACCENTS, type Accent } from "../theme/theme-provider.tsx";

export interface AccentChoiceProps {
  /** Names the group for assistive technology and is shown above it. */
  label: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  /** Help shown under the swatches; the group is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the group is invalid and described by this message. */
  error?: ReactNode;
  /** The name of each preset, in the language of the page. */
  names: Readonly<Record<Accent, string>>;
  value: Accent;
  onValueChange: (value: Accent) => void;
  disabled?: boolean;
  className?: string;
}

function isAccent(value: string): value is Accent {
  return ACCENTS.some((accent) => accent === value);
}

/**
 * The six accent presets as swatches (Q36): a labelled radio group, each swatch painted with its own preset
 * in the theme that shows and named for assistive technology; the chosen one carries a check mark as well as a ring.
 */
export function AccentChoice({ label, name, description, error, names, value, onValueChange, disabled, className }: AccentChoiceProps): ReactElement {
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
        className="flex flex-row flex-wrap gap-3 p-1 data-disabled:opacity-64"
        data-slot="accent-choice"
        disabled={disabled}
        name={name}
        onValueChange={(next) => {
          if (typeof next === "string" && isAccent(next)) {
            onValueChange(next);
          }
        }}
        value={value}
      >
        {ACCENTS.map((accent) => (
          <RadioPrimitive.Root
            aria-label={names[accent]}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground data-checked:ring-2 data-checked:ring-foreground data-checked:ring-offset-2 data-checked:ring-offset-background data-disabled:cursor-not-allowed"
            data-accent={accent}
            data-slot="accent-choice-swatch"
            key={accent}
            value={accent}
          >
            <RadioPrimitive.Indicator className="flex items-center justify-center data-unchecked:hidden" keepMounted={false}>
              <CheckIcon aria-hidden="true" className="size-4" />
            </RadioPrimitive.Indicator>
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
