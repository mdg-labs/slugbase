import { OTPField } from "@base-ui/react/otp-field";
import type { ReactElement, Ref } from "react";
import { cn } from "../lib/utils.ts";

const DEFAULT_LENGTH = 6;

export interface TotpProps {
  /** The code entered so far: digits only, at most `length` of them. */
  value: string;
  onValueChange: (value: string) => void;
  /** Called once with the code when its last digit is entered or a complete code is pasted. */
  onComplete?: (value: string) => void;
  /** How many digits the code has. */
  length?: number;
  /** Names the slot at a 1-based position for assistive technology; the label of the field names the first one. */
  slotLabel: (position: number, length: number) => string;
  /** Names the field as it is posted. */
  name?: string;
  disabled?: boolean;
  className?: string;
  /** The first slot, for moving focus to the field. */
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * A one-time code entered one digit per slot, as the authenticator app shows it. Typing, pasting and a
 * browser's code autofill all fill the slots, and a complete code is reported through `onComplete`.
 * It takes its label, description and error from the surrounding `FormField`.
 */
export function Totp({
  value,
  onValueChange,
  onComplete,
  length = DEFAULT_LENGTH,
  slotLabel,
  name,
  disabled,
  className,
  inputRef,
}: TotpProps): ReactElement {
  return (
    <OTPField.Root
      className={cn("flex w-full gap-1.5 sm:gap-2", className)}
      data-slot="totp"
      disabled={disabled}
      length={length}
      name={name}
      onValueChange={onValueChange}
      onValueComplete={onComplete}
      value={value}
    >
      {Array.from({ length }, (_, index) => (
        <OTPField.Input
          aria-label={slotLabel(index + 1, length)}
          className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background text-center font-medium text-foreground text-lg shadow-xs/5 outline-none ring-ring/24 transition-shadow focus-visible:border-ring focus-visible:ring-[3px] aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 disabled:opacity-64 sm:h-10 dark:bg-input/32"
          data-slot="totp-slot"
          key={index}
          ref={index === 0 ? inputRef : undefined}
        />
      ))}
    </OTPField.Root>
  );
}
