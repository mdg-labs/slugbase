import type { ReactNode } from "react";

import { Button } from "./Button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
} from "./Dialog.js";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
  testId?: string;
  body?: ReactNode;
};

/** Keyboard-friendly destructive / high-impact confirmation (Radix dialog + focus trap). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = false,
  busy = false,
  testId = "confirm-dialog",
  body,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description} testId={testId}>
        {body ? (
          <div
            className="px-sp-8 py-sp-6"
            style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
          >
            {body}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-sp-3 border-t border-[color:var(--border-subtle)] px-sp-8 py-sp-6">
          <DialogClose asChild>
            <Button variant="ghost" disabled={busy} type="button">
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={destructive ? "primary" : "primary"}
            className={
              destructive
                ? "border-[color:var(--danger-border)] bg-danger text-[color:var(--danger-fg)] hover:bg-danger"
                : undefined
            }
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
