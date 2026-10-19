import { useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { FormField } from "./form-field.tsx";

export interface TypedConfirmProps {
  open: boolean;
  /** Called with `false` when the dialog is dismissed by Cancel, Escape or the backdrop. */
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** What the action does and to what; it describes the dialog for assistive technology. */
  description: ReactNode;
  /** The text the member has to type for the action to be enabled, such as a recipient's name. */
  expected: string;
  /** Names the field and tells the member what to type. */
  inputLabel: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  /** Called when the member confirms with the expected text typed; the dialog stays open until the app closes it, so a failure can be shown in place. */
  onConfirm: () => void;
  /** Keeps the confirm button disabled although the expected text is typed, while something the action depends on is not known yet. */
  confirmDisabled?: boolean;
  /** Whether the confirm button is styled as the destructive action. */
  destructive?: boolean;
  /** Shows the wait on the confirm button and keeps the dialog from being dismissed meanwhile. */
  loading?: boolean;
  /** Options of the action, such as a checkbox, between the description and the field. */
  children?: ReactNode;
  /** Why the last attempt failed, shown under the field. */
  error?: ReactNode;
}

/** Whether `typed` is the expected text: the same characters, with the whitespace the member pasted around it ignored. */
export function matchesExpected(typed: string, expected: string): boolean {
  return expected.trim() !== "" && typed.trim() === expected.trim();
}

type BodyProps = Omit<TypedConfirmProps, "open" | "onOpenChange">;

function Body({ title, description, expected, inputLabel, confirmLabel, cancelLabel, onConfirm, confirmDisabled = false, destructive = false, loading = false, children, error }: BodyProps): ReactElement {
  const [typed, setTyped] = useState("");
  const matches = matchesExpected(typed, expected) && !confirmDisabled;

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (matches && !loading) {
      onConfirm();
    }
  }

  return (
    <form className="flex min-h-0 flex-col" noValidate onSubmit={submit}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-4 px-6 pb-6">
        {children}
        <FormField error={error} label={inputLabel}>
          <Input
            autoComplete="off"
            disabled={loading}
            onChange={(event) => {
              setTyped(event.currentTarget.value);
            }}
            spellCheck={false}
            value={typed}
          />
        </FormField>
      </div>
      <AlertDialogFooter>
        <AlertDialogClose disabled={loading} render={<Button type="button" variant="outline" />}>
          {cancelLabel}
        </AlertDialogClose>
        <Button disabled={!matches} loading={loading} type="submit" variant={destructive ? "destructive" : "default"}>
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

/**
 * A confirmation for an action that is hard to take back (doc 03 `typed-confirm`): a coss AlertDialog with a field, and the
 * confirm button stays disabled until the member has typed the expected text, such as the name of the person who becomes an
 * owner. Pressing Enter in the field confirms only when the text matches. The field starts empty every time the dialog opens.
 */
export function TypedConfirm({ open, onOpenChange, ...body }: TypedConfirmProps): ReactElement {
  const { loading = false } = body;
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!loading) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <AlertDialogPopup data-slot="typed-confirm">
        <Body {...body} />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
