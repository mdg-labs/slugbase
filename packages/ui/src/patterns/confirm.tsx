import { useRef, type ReactElement, type ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";

export interface ConfirmProps {
  open: boolean;
  /** Called with `false` when the dialog is dismissed by Cancel, Escape or the backdrop. */
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** What the action does and to what; it describes the dialog for assistive technology. */
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  /** Called when the member confirms; the dialog stays open until the app closes it, so a failure can be shown in place. */
  onConfirm: () => void;
  /** Whether the confirm button is styled as the destructive action. */
  destructive?: boolean;
  /** Shows the wait on the confirm button and keeps the dialog from being dismissed meanwhile. */
  loading?: boolean;
}

/** A confirmation before a revocation or removal (doc 03 `confirm`): a coss AlertDialog whose focus starts on Cancel. */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = false,
  loading = false,
}: ConfirmProps): ReactElement {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!loading) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <AlertDialogPopup data-slot="confirm" initialFocus={cancel}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={loading} ref={cancel} render={<Button variant="outline" />}>
            {cancelLabel}
          </AlertDialogClose>
          <Button loading={loading} onClick={onConfirm} variant={destructive ? "destructive" : "default"}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
