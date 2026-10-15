import { InfoIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.tsx";

export interface InlineNoteProps {
  /** A short heading above the text. */
  title?: ReactNode;
  /** The explanation. */
  children: ReactNode;
  className?: string;
}

/** An explanation that sits in the page beside what it explains. It is not a condition to act on and is not announced. */
export function InlineNote({ title, children, className }: InlineNoteProps): ReactElement {
  return (
    <Alert className={className} role="note" variant="info">
      <InfoIcon aria-hidden="true" />
      {title === undefined ? null : <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
