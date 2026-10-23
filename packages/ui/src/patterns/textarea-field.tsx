import type { ReactElement, ReactNode } from "react";
import { Textarea } from "../components/ui/textarea.tsx";
import { FormField } from "./form-field.tsx";

export interface TextareaFieldProps {
  label: ReactNode;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  /** The most characters the field takes; the counter shows how many are left of it. */
  maxLength: number;
  /** The counter's text for the current length, in the interface language, for example "12 / 1,000". */
  counter: ReactNode;
  /** Why the value is refused. While it is set the field is invalid and described by this message. */
  error?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** A labelled multi-line field with a character counter (doc 03 "Textarea with counter"). */
export function TextareaField({ label, name, value, onChange, maxLength, counter, error, disabled, className }: TextareaFieldProps): ReactElement {
  return (
    <FormField className={className} description={<span aria-live="off">{counter}</span>} error={error} label={label} name={name}>
      <Textarea
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        value={value}
      />
    </FormField>
  );
}
