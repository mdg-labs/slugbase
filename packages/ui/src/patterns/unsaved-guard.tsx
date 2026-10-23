import type { ReactElement, ReactNode } from "react";
import { Confirm } from "./confirm.tsx";

export interface UnsavedGuardProps {
  open: boolean;
  title: ReactNode;
  /** What closing loses. */
  description: ReactNode;
  discardLabel: ReactNode;
  keepEditingLabel: ReactNode;
  /** Called when the member chooses to lose the changes. */
  onDiscard: () => void;
  /** Called when the member goes back to the form, by the button, Escape or the backdrop. */
  onKeepEditing: () => void;
}

/** The question asked before a form with unsaved changes closes (doc 03 `unsaved-guard`): keep editing, or discard. */
export function UnsavedGuard({ open, title, description, discardLabel, keepEditingLabel, onDiscard, onKeepEditing }: UnsavedGuardProps): ReactElement {
  return (
    <Confirm
      cancelLabel={keepEditingLabel}
      confirmLabel={discardLabel}
      description={description}
      destructive
      onConfirm={onDiscard}
      onOpenChange={(next) => {
        if (!next) {
          onKeepEditing();
        }
      }}
      open={open}
      title={title}
    />
  );
}
