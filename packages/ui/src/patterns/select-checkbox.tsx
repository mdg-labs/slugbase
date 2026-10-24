import type { ReactElement } from "react";
import { Checkbox } from "../components/ui/checkbox.tsx";

export interface SelectCheckboxProps {
  /** Names the checkbox for assistive technology, and says which row or card it selects. */
  label: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
}

/** The checkbox that selects one row or card of a list, with no visible label of its own (doc 03 `bulk-bar`). */
export function SelectCheckbox({ label, checked, onCheckedChange, className }: SelectCheckboxProps): ReactElement {
  return (
    <Checkbox
      aria-label={label}
      className={className}
      {...(checked === undefined ? {} : { checked })}
      onCheckedChange={(next) => {
        onCheckedChange?.(next);
      }}
    />
  );
}
