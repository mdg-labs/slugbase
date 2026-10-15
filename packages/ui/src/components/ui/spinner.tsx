import { Loader2Icon } from "lucide-react";
import { createContext, use } from "react";
import type React from "react";
import { cn } from "../../lib/utils.ts";

const SpinnerLabelContext = createContext<string | undefined>(undefined);

export interface SpinnerLabelProviderProps {
  /** What assistive technology announces for every spinner below, in the interface language. */
  label: string;
  children: React.ReactNode;
}

/** Supplies the accessible label of the spinners below, so the library holds no wording of its own. */
export function SpinnerLabelProvider({ label, children }: SpinnerLabelProviderProps): React.ReactElement {
  return <SpinnerLabelContext value={label}>{children}</SpinnerLabelContext>;
}

export function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
  const label = use(SpinnerLabelContext);
  return (
    <Loader2Icon
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}
