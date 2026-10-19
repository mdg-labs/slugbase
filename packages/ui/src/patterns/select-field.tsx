import type { ReactElement, ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.tsx";
import { cn } from "../lib/utils.ts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.tsx";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: ReactNode;
  /** Keeps the label from showing while it still names the select to assistive technology, for a select in a table cell. */
  hideLabel?: boolean;
  /** Names the field as it is posted. */
  name?: string;
  /** Help shown under the field; the field is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the field is invalid and described by this message. */
  error?: ReactNode;
  options: readonly SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/** A label, a Select and the message that says what is wrong with its value, tied together for assistive technology. */
export function SelectField({ label, hideLabel = false, name, description, error, options, value, onValueChange, disabled, className }: SelectFieldProps): ReactElement {
  const invalid = error !== undefined && error !== null && error !== false;
  return (
    <Field className={cn("items-stretch gap-1.5", className)} disabled={disabled} invalid={invalid} name={name}>
      <FieldLabel className={hideLabel ? "sr-only" : undefined}>{label}</FieldLabel>
      <Select
        items={options}
        onValueChange={(next) => {
          if (next !== null) {
            onValueChange(next);
          }
        }}
        value={value}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem key={option.value} label={option.label} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError className="text-destructive-text" match={invalid}>
        {error}
      </FieldError>
    </Field>
  );
}
