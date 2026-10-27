import { SEARCH_QUERY_MAX_LENGTH } from "@slugbase/contracts";
import { Input } from "@slugbase/ui";
import { FormField } from "@slugbase/ui/patterns";
import { useEffect, useRef, useState, type ReactElement } from "react";

/** How long the field waits after the last key before it searches (doc 02 section 9.1). */
export const SEARCH_FIELD_DELAY_MS = 150;

export interface SearchFieldProps {
  /** The text the list is narrowed to now: the address's, or the empty text. */
  readonly value: string;
  /** Called with the text typed, without the whitespace around it, once the member has stopped typing for `SEARCH_FIELD_DELAY_MS`; the empty text takes the narrowing off. */
  readonly onSearch: (text: string) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly className?: string;
}

/**
 * The search field of a list of bookmarks (doc 03 `table-filters`). It keeps what is typed while the member types and reports
 * it after a pause, so the request is made for the text and not for each key. A text the list is narrowed to by other means (a
 * chip taken off, the filters cleared, the browser's back button) replaces what is typed, and a text this field reported itself
 * does not, so the member's own whitespace at the end of a word is not taken away while they type.
 */
export function SearchField({ value, onSearch, label, placeholder, className }: SearchFieldProps): ReactElement {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The text the list was last narrowed to, whether this field reported it or the address changed by itself.
  const reported = useRef(value);
  useEffect(() => {
    if (value !== reported.current) {
      reported.current = value;
      clearTimeout(timer.current);
      timer.current = undefined;
      setDraft(value);
    }
  }, [value]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  function change(next: string): void {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const text = next.trim();
      if (text !== reported.current) {
        reported.current = text;
        onSearch(text);
      }
    }, SEARCH_FIELD_DELAY_MS);
  }
  return (
    <FormField className={className} label={label}>
      <Input
        autoComplete="off"
        maxLength={SEARCH_QUERY_MAX_LENGTH}
        onChange={(event) => {
          change(event.target.value);
        }}
        placeholder={placeholder}
        spellCheck={false}
        type="search"
        value={draft}
      />
    </FormField>
  );
}
