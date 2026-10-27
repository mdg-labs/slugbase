import { SearchIcon } from "lucide-react";
import type { ReactElement, Ref } from "react";
import { Button } from "../components/ui/button.tsx";
import { Kbd } from "../components/ui/kbd.tsx";

export interface SearchEntryProps {
  /** The name of the button, and the prompt drawn in it. */
  label: string;
  /** The keys that open the search, drawn at the end of the button. */
  shortcut: readonly string[];
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** A button that looks like a large search field and opens the search when pressed (doc 03 `kbd-button` styled as an input): the home screen's entry to the command palette. */
export function SearchEntry({ label, shortcut, onClick, ref }: SearchEntryProps): ReactElement {
  return (
    <Button className="h-11 w-full justify-start px-4 text-muted-foreground sm:h-11" onClick={onClick} ref={ref} variant="outline">
      <SearchIcon aria-hidden="true" />
      <span className="truncate">{label}</span>
      <span aria-hidden="true" className="ms-auto flex shrink-0 items-center gap-0.5 max-sm:hidden">
        {shortcut.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </Button>
  );
}
