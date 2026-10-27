import { SearchIcon, XIcon } from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode, type Ref, type RefObject } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "../components/ui/command.tsx";
import { DialogClose, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { EmptyState } from "./empty-state.tsx";

/** How an item was chosen: Enter or a click opens it, a modified Enter or click opens it in a new tab or edits it. */
export type CommandPaletteIntent = "open" | "newTab" | "edit";

export interface CommandPaletteItem {
  /** Keys the item within its section. */
  id: string;
  label: string;
  /** Words besides the label that the query matches, for example a host or a synonym. */
  keywords?: string;
  /** A decorative icon. */
  icon?: ReactNode;
  /** Text after the label, for example the host of a bookmark. */
  detail?: ReactNode;
  /** The keys of the item's own shortcut, shown at the end of the row. */
  shortcut?: readonly string[];
  onSelect: (intent: CommandPaletteIntent) => void;
}

export interface CommandPaletteSection {
  id: string;
  title?: string;
  /**
   * What the section shows: its items, skeleton rows while they load, an option that says what failed and retries when chosen, or a
   * compact notice that it has none, which is shown above the list since it is not an option of it.
   */
  state?: "ready" | "loading" | "error" | "empty";
  items?: readonly CommandPaletteItem[];
  /** Names the wait for assistive technology while `state` is `loading`. */
  loadingLabel?: string;
  /** Shown while `state` is `error`: what failed and the way to try again. */
  error?: { message: string; retryLabel: string; onRetry: () => void };
  /** Shown while `state` is `empty`. */
  notice?: { title: string; description?: string; icon?: ReactNode };
}

export interface CommandPaletteHint {
  id: string;
  /** The keys pressed together. */
  keys: readonly string[];
  label: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog's accessible name; it is not drawn. */
  title: string;
  description?: string;
  inputLabel: string;
  placeholder: string;
  /** The sections, in order. A section's items are narrowed by the query; one without a match is left out. */
  sections: readonly CommandPaletteSection[];
  /** Said when the query matches nothing. */
  noResults: string;
  /** The text a screen reader is told when the number of items on offer changes. */
  announce: (count: number) => string;
  footerHints: readonly CommandPaletteHint[];
  /** The name of the close button drawn on phones, where there is no Esc key. */
  closeLabel: string;
  /** Called with the query as it changes. */
  onQueryChange?: (query: string) => void;
  /** A page below the first: its name beside the input, and the way back, which Backspace in an empty input takes. */
  page?: { label: string; onBack: () => void };
  /** Where focus goes when the palette closes. */
  finalFocus?: RefObject<HTMLElement | null> | (() => HTMLElement | boolean | null);
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function matches(item: CommandPaletteItem, terms: readonly string[]): boolean {
  const haystack = fold(`${item.label} ${item.keywords ?? ""}`);
  return terms.every((term) => haystack.includes(term));
}

interface Shown {
  section: CommandPaletteSection;
  state: NonNullable<CommandPaletteSection["state"]>;
  items: readonly CommandPaletteItem[];
}

const SKELETON_ROWS = ["a", "b", "c"] as const;

function intentOf(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): CommandPaletteIntent {
  if (event.altKey) {
    return "edit";
  }
  return event.metaKey || event.ctrlKey ? "newTab" : "open";
}

/**
 * The command palette (doc 03 section 9): a coss Command in a Dialog, with an input over grouped items and a footer of key hints.
 * It is a sheet that fills the width of a phone. The app supplies the sections and what choosing an item does; the palette
 * narrows the items by the query, shows a section's wait, failure or emptiness in its place, and announces how many items
 * are on offer. Enter or a click chooses the highlighted item; Ctrl or Command with Enter opens it in a new tab and Alt with Enter edits it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  title,
  description,
  inputLabel,
  placeholder,
  sections,
  noResults,
  announce,
  footerHints,
  closeLabel,
  onQueryChange,
  page,
  finalFocus,
}: CommandPaletteProps): ReactElement {
  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandDialogPopup finalFocus={finalFocus} data-slot="command-palette">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {description === undefined ? null : <DialogDescription className="sr-only">{description}</DialogDescription>}
        <PaletteBody
          key={page?.label ?? ""}
          announce={announce}
          closeLabel={closeLabel}
          footerHints={footerHints}
          inputLabel={inputLabel}
          noResults={noResults}
          onQueryChange={onQueryChange}
          page={page}
          placeholder={placeholder}
          sections={sections}
        />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

type BodyProps = Pick<
  CommandPaletteProps,
  "announce" | "closeLabel" | "footerHints" | "inputLabel" | "noResults" | "onQueryChange" | "page" | "placeholder" | "sections"
>;

function PaletteBody({ announce, closeLabel, footerHints, inputLabel, noResults, onQueryChange, page, placeholder, sections }: BodyProps): ReactElement {
  const [query, setQuery] = useState("");
  const terms = fold(query).split(/\s+/).filter((term) => term !== "");

  const shown = sections.flatMap((section): Shown[] => {
    const state = section.state ?? "ready";
    if (state !== "ready") {
      return [{ section, state, items: [] }];
    }
    const items = (section.items ?? []).filter((item) => matches(item, terms));
    return items.length === 0 ? [] : [{ section, state, items }];
  });
  const count = shown.reduce((total, { items }) => total + items.length, 0);
  const settled = shown.every(({ state }) => state === "ready");
  const nothing = count === 0 && settled && terms.length > 0;
  const notices = shown.filter(({ state, section }) => state === "empty" && section.notice !== undefined);
  const listed = shown.filter(({ state }) => state !== "empty");
  // What the live region says: a failure or a wait before the count, since the count then leaves out what is missing.
  const said = new Set(listed.flatMap(({ section, state }) => (state === "error" ? [section.error?.message ?? ""] : state === "loading" ? [section.loadingLabel ?? ""] : [])));
  const message = nothing ? noResults : said.size > 0 ? [...said].join(" ") : announce(count);

  // The item Enter acts on is the one the input names as its active descendant.
  const highlightedItem = (input: EventTarget): CommandPaletteItem | undefined => {
    const id = input instanceof HTMLElement ? input.getAttribute("aria-activedescendant") : null;
    const key = id === null ? undefined : document.getElementById(id)?.dataset.itemKey;
    return shown.flatMap(({ section, items }) => items.map((item) => ({ key: `${section.id}:${item.id}`, item }))).find((entry) => entry.key === key)?.item;
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) {
      const item = highlightedItem(event.target);
      if (item !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        item.onSelect(intentOf(event));
      }
    } else if (event.key === "Backspace" && query === "" && page !== undefined) {
      event.preventDefault();
      page.onBack();
    }
  };

  return (
    <Command
      onValueChange={(value) => {
        setQuery(value);
        onQueryChange?.(value);
      }}
      value={query}
    >
      <CommandPanel onKeyDownCapture={onKeyDownCapture}>
        <div className="flex items-center border-b">
          <CommandInput
            aria-label={inputLabel}
            placeholder={placeholder}
            startAddon={page === undefined ? null : <Kbd className="h-6 shrink-0 px-2 text-foreground">{page.label}</Kbd>}
          />
          <DialogClose aria-label={closeLabel} render={<Button className="me-2 sm:hidden" size="icon" variant="ghost" />}>
            <XIcon aria-hidden="true" />
          </DialogClose>
        </div>
        <div aria-live="polite" className="sr-only" role="status">
          {message}
        </div>
        {notices.map(({ section }) => (
          <div className="border-b [&_[data-slot=empty-media]]:mb-0 [&_[data-slot=empty]]:gap-3 [&_[data-slot=empty]]:py-4" key={section.id}>
            <EmptyState description={section.notice?.description} headingLevel={3} icon={section.notice?.icon} title={section.notice?.title ?? ""} />
          </div>
        ))}
        {nothing ? (
          <p className="flex items-center justify-center gap-2 px-4 py-10 text-muted-foreground text-sm">
            <SearchIcon aria-hidden="true" className="size-4" />
            {noResults}
          </p>
        ) : (
          <CommandList>
            {listed.map(({ section, state, items }) => (
              <CommandGroup key={section.id}>
                {section.title === undefined ? null : <CommandGroupLabel>{section.title}</CommandGroupLabel>}
                {state === "loading" ? (
                  <div aria-hidden="true" className="flex flex-col gap-1.5 px-2 py-1.5">
                    {SKELETON_ROWS.map((row) => (
                      <Skeleton className="h-7 rounded-md" key={row} />
                    ))}
                  </div>
                ) : null}
                {state === "error" && section.error !== undefined ? (
                  <CommandItem
                    data-item-key={`${section.id}:error`}
                    onClick={section.error.onRetry}
                    value={`${section.id}:error`}
                  >
                    <span className="min-w-0 flex-1 truncate text-destructive-foreground">{section.error.message}</span>
                    <span className="shrink-0 rounded-md border px-2 py-0.5 font-medium text-xs">{section.error.retryLabel}</span>
                  </CommandItem>
                ) : null}
                {items.map((item) => (
                  <CommandItem
                    data-item-key={`${section.id}:${item.id}`}
                    key={item.id}
                    onClick={(event: MouseEvent<HTMLDivElement>) => {
                      item.onSelect(intentOf(event));
                    }}
                    value={`${section.id}:${item.id}`}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                    {item.detail === undefined ? null : <span className="min-w-0 truncate text-muted-foreground text-xs">{item.detail}</span>}
                    {item.shortcut === undefined ? null : (
                      <CommandShortcut>
                        {item.shortcut.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        )}
        <CommandFooter>
          {footerHints.map((hint) => (
            <span className="flex items-center gap-1.5" key={hint.id}>
              <span className="flex items-center gap-0.5">
                {hint.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
              {hint.label}
            </span>
          ))}
        </CommandFooter>
      </CommandPanel>
    </Command>
  );
}

export interface CommandTriggerProps {
  /** The name of the button, and the text drawn in it from the `md` breakpoint up. */
  label: string;
  /** The keys that open the palette, drawn at the end of the button. */
  shortcut: readonly string[];
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** The top bar's command trigger (doc 03 "App shell"): a search-looking button with the shortcut that opens the palette. */
export function CommandTrigger({ label, shortcut, onClick, ref }: CommandTriggerProps): ReactElement {
  return (
    <Button
      aria-label={label}
      className="justify-start text-muted-foreground md:w-56 max-md:size-9 max-md:px-0"
      onClick={onClick}
      ref={ref}
      variant="outline"
    >
      <SearchIcon aria-hidden="true" />
      <span aria-hidden="true" className="max-md:hidden">
        {label}
      </span>
      <span aria-hidden="true" className="ms-auto flex items-center gap-0.5 max-md:hidden">
        {shortcut.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </Button>
  );
}
