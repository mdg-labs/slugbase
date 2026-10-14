import type { ReactElement, ReactNode } from "react";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";

export interface CheckboxFieldProps {
  label: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** A checkbox with its label: clicking either one toggles it. */
export function CheckboxField({ label, className, ...props }: CheckboxFieldProps): ReactElement {
  return (
    <Field className={className}>
      <FieldLabel className="cursor-pointer">
        <Checkbox {...props} />
        {label}
      </FieldLabel>
    </Field>
  );
}
