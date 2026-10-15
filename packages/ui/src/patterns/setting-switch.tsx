import type { ReactElement, ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { cn } from "../lib/utils.ts";

export interface SettingSwitchProps {
  label: ReactNode;
  /** What the setting does; the switch is described by it. */
  description?: ReactNode;
  /** Why the change was refused. While it is set the switch is invalid and described by this message. */
  error?: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** A switch with its label and a description of what it changes (doc 03 `setting-switch`): clicking the label toggles it. */
export function SettingSwitch({ label, description, error, name, checked, onCheckedChange, disabled, className }: SettingSwitchProps): ReactElement {
  const invalid = error !== undefined && error !== null && error !== false;
  return (
    <Field className={cn("flex-row items-start justify-between gap-4", className)} disabled={disabled} invalid={invalid} name={name}>
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel className="cursor-pointer">{label}</FieldLabel>
        {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
        <FieldError className="text-destructive-text" match={invalid}>
          {error}
        </FieldError>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          onCheckedChange(next);
        }}
      />
    </Field>
  );
}
