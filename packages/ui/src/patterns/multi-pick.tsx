import { Combobox } from "@base-ui/react/combobox";
import { XIcon } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.tsx";
import { cn } from "../lib/utils.ts";
import type { PickerOption } from "./picker.tsx";

/** What a `multi-pick` offers once the typed text names nothing that is in the list. */
export interface MultiPickCreate {
  /** The text of the item that creates `name`, such as `Create folder "Reading"`. */
  label: (name: string) => string;
  /** Called with the typed text, trimmed, when the item is chosen. The pick does not select anything itself: the caller adds the new option to `options` and `value` when it has made it. */
  onCreate: (name: string) => void;
}

export interface MultiPickProps {
  label: ReactNode;
  /** Help shown under the field; the field is described by it. */
  description?: ReactNode;
  /** Why the value is refused. While it is set the field is invalid and described by this message. */
  error?: ReactNode;
  /** What can be chosen. Every `value` has its option here, which is where its chip takes its label from. */
  options: readonly PickerOption[];
  /** The `value` of every chosen option, in the order the chips are shown. */
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  /** Shown in the input while nothing is typed. */
  placeholder?: string;
  /** Shown in the list when there is no option, or none matches the search. Not shown while the options are loading or could not be loaded. */
  emptyLabel: ReactNode;
  /** Set while the options are still being read; the list says so instead of saying there are none. */
  loadingLabel?: ReactNode;
  /** Set when the options could not be read; the list says so instead of saying there are none. */
  unavailableLabel?: ReactNode;
  /** The accessible name of the button that takes the chip of `label` off. */
  removeLabel: (label: string) => string;
  /** Makes a text that no option carries a choice of its own. */
  creatable?: MultiPickCreate;
  disabled?: boolean;
  className?: string;
}

interface Item extends PickerOption {
  create?: true;
}

const CREATE_VALUE = "\u0000create";

function matches(item: Item, query: string): boolean {
  if (item.create === true) {
    return true;
  }
  const needle = query.trim().toLowerCase();
  return needle === "" || item.label.toLowerCase().includes(needle) || (item.description?.toLowerCase().includes(needle) ?? false);
}

/**
 * Several options out of many, chosen by searching and shown as chips (doc 03 `multi-pick`): a Base UI combobox in
 * multiple mode whose input filters the list by label and description. With `creatable`, a text that no option carries
 * is offered as a last item that hands the text to the caller. The list says it is loading, or that it could not be
 * read, instead of saying there is nothing to choose.
 */
export function MultiPick({
  label,
  description,
  error,
  options,
  value,
  onValueChange,
  placeholder,
  emptyLabel,
  loadingLabel,
  unavailableLabel,
  removeLabel,
  creatable,
  disabled,
  className,
}: MultiPickProps): ReactElement {
  const anchor = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const invalid = error !== undefined && error !== null && error !== false;
  const typed = query.trim();
  const offersCreate = creatable !== undefined && typed !== "" && !options.some((option) => option.label.toLowerCase() === typed.toLowerCase());
  const items: readonly Item[] = offersCreate ? [...options, { value: CREATE_VALUE, label: creatable.label(typed), create: true }] : options;
  const chosen = value.flatMap((entry) => options.find((option) => option.value === entry) ?? []);
  const listed = loadingLabel !== undefined || unavailableLabel !== undefined;
  return (
    <Field className={cn("items-stretch gap-1.5", className)} disabled={disabled} invalid={invalid}>
      <FieldLabel>{label}</FieldLabel>
      <Combobox.Root
        autoHighlight
        disabled={disabled}
        filter={matches}
        inputValue={query}
        isItemEqualToValue={(item: Item, picked: Item) => item.value === picked.value}
        items={items}
        multiple
        onInputValueChange={setQuery}
        onOpenChange={setOpen}
        open={open}
        onValueChange={(next: Item[]) => {
          if (next.some((item) => item.create === true)) {
            setQuery("");
            creatable?.onCreate(typed);
            return;
          }
          setQuery("");
          onValueChange(next.map((item) => item.value));
        }}
        value={chosen}
      >
        <Combobox.Chips
          className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-background p-1 shadow-xs/5 outline-none ring-ring/24 transition-shadow focus-within:border-ring focus-within:ring-[3px] data-[invalid]:border-destructive/36 sm:min-h-8 dark:bg-input/32"
          data-invalid={invalid ? "" : undefined}
          data-slot="multi-pick-chips"
          ref={anchor}
        >
          {chosen.map((item) => (
            <Combobox.Chip
              className="flex max-w-full items-center gap-1 rounded-md bg-accent ps-2 pe-1 text-accent-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-xs"
              data-slot="multi-pick-chip"
              key={item.value}
            >
              {item.icon === undefined ? null : (
                <span aria-hidden="true" className="shrink-0">
                  {item.icon}
                </span>
              )}
              <span className="min-w-0 truncate py-0.5">{item.label}</span>
              <Combobox.ChipRemove
                aria-label={removeLabel(item.label)}
                className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64"
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          ))}
          <Combobox.Input
            className="h-7 min-w-24 flex-1 bg-transparent px-2 text-base text-foreground outline-none placeholder:text-muted-foreground/72 disabled:opacity-64 sm:h-6 sm:text-sm"
            data-slot="multi-pick-input"
            // With the list shut, Escape would take every chip off; it is left to the surrounding overlay, which closes (and asks about unsaved changes) instead.
            onKeyDown={(event) => {
              if (event.key === "Escape" && !open) {
                event.preventBaseUIHandler();
              }
            }}
            placeholder={chosen.length === 0 ? placeholder : undefined}
          />
        </Combobox.Chips>
        <Combobox.Portal>
          <Combobox.Positioner anchor={anchor} className="z-50 select-none" sideOffset={4}>
            <Combobox.Popup
              className="w-(--anchor-width) origin-(--transform-origin) rounded-lg border bg-popover text-foreground shadow-lg/5 outline-none"
              data-slot="multi-pick-popup"
            >
              {loadingLabel === undefined ? null : (
                <div className="px-3 py-2 text-muted-foreground text-sm" data-slot="multi-pick-loading" role="status">
                  {loadingLabel}
                </div>
              )}
              {unavailableLabel === undefined ? null : (
                <div className="px-3 py-2 text-destructive-text text-sm" data-slot="multi-pick-unavailable" role="alert">
                  {unavailableLabel}
                </div>
              )}
              <Combobox.Empty className="px-3 py-2 text-muted-foreground text-sm empty:hidden">{listed ? null : emptyLabel}</Combobox.Empty>
              <Combobox.List className="max-h-60 overflow-y-auto p-1 empty:hidden" data-slot="multi-pick-list">
                {(item: Item) => (
                  <Combobox.Item
                    className="flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:text-sm"
                    key={item.value}
                    value={item}
                  >
                    {item.icon === undefined ? null : (
                      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                        {item.icon}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="wrap-anywhere">{item.label}</span>
                      {item.description === undefined ? null : <span className="wrap-anywhere text-muted-foreground text-xs">{item.description}</span>}
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
