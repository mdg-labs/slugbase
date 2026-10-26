import type { FocusEvent, ReactElement } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../components/ui/input-group.tsx";
import { Spinner } from "../components/ui/spinner.tsx";

export interface SlugInputProps {
  /** The slug as it is held: already trimmed and lower-cased. */
  value: string;
  /** Called with the slug as the member typed or pasted it, trimmed and lower-cased. */
  onValueChange: (value: string) => void;
  /** Called when the field loses focus. */
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  /** Shows the spinner at the end of the field, while something about the slug is being looked up. */
  pending?: boolean;
  /** What assistive technology announces for the spinner. */
  pendingLabel: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A slug field (doc 03 `slug-input`): the fixed start text `/go/`, then a mono input that trims and lower-cases what is
 * typed, with a spinner at its end while the slug is looked up. Whether the slug is valid is the form field's to say.
 */
export function SlugInput({ value, onValueChange, onBlur, pending = false, pendingLabel, placeholder, disabled }: SlugInputProps): ReactElement {
  return (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText className="font-mono" translate="no">
          /go/
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        className="font-mono"
        disabled={disabled}
        onBlur={onBlur}
        onValueChange={(next) => {
          onValueChange(next.trim().toLowerCase());
        }}
        placeholder={placeholder}
        spellCheck={false}
        translate="no"
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
