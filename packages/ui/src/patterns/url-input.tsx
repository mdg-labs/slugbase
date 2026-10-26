import { GlobeIcon } from "lucide-react";
import type { ClipboardEvent, FocusEvent, ReactElement } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group.tsx";
import { Spinner } from "../components/ui/spinner.tsx";

export interface UrlInputProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Called when the field loses focus. */
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  /** Called when text is pasted into the field; the new value follows in `onValueChange`. */
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  /** Shows the spinner at the end of the field, while something about the address is being looked up. */
  pending?: boolean;
  /** What assistive technology announces for the spinner. */
  pendingLabel: string;
  placeholder?: string;
  disabled?: boolean;
}

/** An address field that looks like a browser's URL bar (doc 03 `url-input`), with a spinner at its end while the address is looked up. */
export function UrlInput({ value, onValueChange, onBlur, onPaste, pending = false, pendingLabel, placeholder, disabled }: UrlInputProps): ReactElement {
  return (
    <InputGroup>
      <InputGroupAddon>
        <GlobeIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        autoComplete="off"
        className="font-mono"
        disabled={disabled}
        inputMode="url"
        onBlur={onBlur}
        onPaste={onPaste}
        onValueChange={(next) => { onValueChange(next); }}
        placeholder={placeholder}
        spellCheck={false}
        translate="no"
        type="url"
        value={value}
      />
      {pending ? (
        <InputGroupAddon align="inline-end">
          <Spinner aria-label={pendingLabel} />
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
