import type { ReactElement, ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.tsx";
import { cn } from "../lib/utils.ts";

export interface FormFieldProps {
  label: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  /** Help shown under the field; the field is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the field is invalid and described by this message. */
  error?: ReactNode;
  /** The control: an `Input` or `SecretInput`, which the label, description and error attach to. */
  children: ReactNode;
  className?: string;
}

/** A label, a control and the message that says what is wrong with its value, tied together for assistive technology. */
export function FormField({ label, name, description, error, children, className }: FormFieldProps): ReactElement {
  const invalid = error !== undefined && error !== null && error !== false;
  return (
    <Field className={cn("items-stretch gap-1.5", className)} invalid={invalid} name={name}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError className="text-destructive-text" match={invalid}>
        {error}
      </FieldError>
    </Field>
  );
}
