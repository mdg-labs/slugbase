import type { ReactElement, ReactNode } from "react";
import { Card, CardPanel } from "../components/ui/card.tsx";
import { CheckboxField } from "./checkbox-field.tsx";
import { CopyValue } from "./copy-value.tsx";

export interface ShownOnceProps {
  /** The secret values the server will not show again: one value, or several such as a set of backup codes. */
  values: readonly string[];
  /** The accessible name of the value, or of the list when there are several. */
  label: string;
  /** The accessible name of the copy button; with several values it copies all of them. */
  copyLabel: string;
  /** Replaces the copy button's name and is announced once the values are on the clipboard. */
  copiedLabel: string;
  /** What is shown once and what to do with it, for example where to keep it. */
  note?: ReactNode;
  /** The statement the member ticks to say the values are saved. */
  acknowledgeLabel: ReactNode;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  className?: string;
}

/**
 * Secret values the server shows only once (doc 03 `shown-once`): a card with the values, a copy button and an
 * acknowledgement checkbox. The surrounding view keeps its "Done" disabled until `acknowledged` is true and drops
 * the values when it closes; the pattern keeps no copy of them.
 */
export function ShownOnce({
  values,
  label,
  copyLabel,
  copiedLabel,
  note,
  acknowledgeLabel,
  acknowledged,
  onAcknowledgedChange,
  className,
}: ShownOnceProps): ReactElement {
  return (
    <Card className={className} data-slot="shown-once">
      <CardPanel className="flex flex-col gap-4">
        {note === undefined ? null : <p className="text-muted-foreground text-sm">{note}</p>}
        {values.length > 1 ? (
          <ul aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
            {values.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        ) : null}
        <CopyValue copiedLabel={copiedLabel} copyLabel={copyLabel} label={label} value={values.join(" ")} />
        <CheckboxField checked={acknowledged} label={acknowledgeLabel} onCheckedChange={onAcknowledgedChange} />
      </CardPanel>
    </Card>
  );
}
