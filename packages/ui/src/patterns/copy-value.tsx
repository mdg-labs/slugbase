import { CheckIcon, CopyIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";

const COPIED_MS = 2000;

export interface CopyValueProps {
  value: string;
  /** The accessible name of the field, for example "Request ID". */
  label: string;
  /** The accessible name of the copy button. */
  copyLabel: string;
  /** Replaces the button's name and is announced once the value is on the clipboard. */
  copiedLabel: string;
  className?: string;
}

/**
 * A value to read and copy: a read-only mono field with a copy button. When the
 * clipboard refuses the write, the value is selected instead, so it can be copied by hand.
 */
export function CopyValue({ value, label, copyLabel, copiedLabel, className }: CopyValueProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await globalThis.navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      input.current?.select();
    }
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Input aria-label={label} className="font-mono" readOnly ref={input} value={value} />
      <Button
        aria-label={copied ? copiedLabel : copyLabel}
        onClick={() => {
          void copy();
        }}
        size="icon"
        variant="outline"
      >
        {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      </Button>
      <span className="sr-only" role="status">
        {copied ? copiedLabel : ""}
      </span>
    </div>
  );
}
