import { Combobox } from "@base-ui/react/combobox";
import { ChevronsUpDownIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.tsx";
import { cn } from "../lib/utils.ts";

export interface PickerOption {
  value: string;
  label: string;
  /** A second line that tells options of one label apart, such as an email address; the search reads it too. */
  description?: string;
  /** A decorative icon shown before the label in the list and in the field once the option is chosen. */
  icon?: ReactNode;
}

export interface PickerProps {
  label: ReactNode;
  /** Help shown under the field; the field is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the field is invalid and described by this message. */
  error?: ReactNode;
  options: readonly PickerOption[];
  /** The `value` of the chosen option; undefined while none is chosen. */
  value: string | undefined;
  onValueChange: (value: string) => void;
  /** Shown in the input while nothing is chosen. */
  placeholder?: string;
  /** Shown in the list when no option matches the search, or when there are none. */
  emptyLabel: ReactNode;
  disabled?: boolean;
  className?: string;
}

function matches(option: PickerOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || option.label.toLowerCase().includes(needle) || (option.description?.toLowerCase().includes(needle) ?? false);
}

/**
 * One option out of many, chosen by searching (doc 03 `picker`): a Base UI combobox whose input filters the list by
 * label and description, with a message in the list when nothing matches.
 */
export function Picker({ label, description, error, options, value, onValueChange, placeholder, emptyLabel, disabled, className }: PickerProps): ReactElement {
  const invalid = error !== undefined && error !== null && error !== false;
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <Field className={cn("items-stretch gap-1.5", className)} disabled={disabled} invalid={invalid}>
      <FieldLabel>{label}</FieldLabel>
      <Combobox.Root
        disabled={disabled}
        filter={matches}
        isItemEqualToValue={(item, chosen) => item.value === chosen.value}
        items={options}
        onValueChange={(next) => {
          if (next !== null) {
            onValueChange(next.value);
          }
        }}
        value={selected}
      >
        <div className="relative">
          {selected?.icon === undefined ? null : (
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-muted-foreground">
              {selected.icon}
            </span>
          )}
          <Combobox.Input
            className={cn("h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 pe-9 text-base text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] aria-invalid:border-destructive/36 disabled:opacity-64 sm:h-8 sm:text-sm dark:bg-input/32", selected?.icon !== undefined && "ps-9")}
            data-slot="picker-input"
            placeholder={placeholder}
          />
          <Combobox.Trigger
            aria-hidden="true"
            className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground"
            tabIndex={-1}
          >
            <ChevronsUpDownIcon className="size-4" />
          </Combobox.Trigger>
        </div>
        <Combobox.Portal>
          <Combobox.Positioner className="z-50 select-none" sideOffset={4}>
            <Combobox.Popup
              className="w-(--anchor-width) origin-(--transform-origin) rounded-lg border bg-popover text-foreground shadow-lg/5 outline-none"
              data-slot="picker-popup"
            >
              <Combobox.Empty className="px-3 py-2 text-muted-foreground text-sm empty:hidden">{emptyLabel}</Combobox.Empty>
              <Combobox.List className="max-h-60 overflow-y-auto p-1 empty:hidden" data-slot="picker-list">
                {(option: PickerOption) => (
                  <Combobox.Item
                    className="flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:text-sm"
                    key={option.value}
                    value={option}
                  >
                    {option.icon === undefined ? null : (
                      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                        {option.icon}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="wrap-anywhere">{option.label}</span>
                      {option.description === undefined ? null : <span className="wrap-anywhere text-muted-foreground text-xs">{option.description}</span>}
                    </span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError className="text-destructive-text" match={invalid}>
        {error}
      </FieldError>
    </Field>
  );
}
