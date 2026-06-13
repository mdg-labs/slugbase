import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = {
  children: ReactNode;
  title: string;
  description?: string;
  className?: string;
  testId?: string;
};

export function DialogOverlay({
  className = "",
  ...props
}: DialogPrimitive.DialogOverlayProps) {
  return (
    <DialogPrimitive.Overlay
      className={`fixed inset-0 z-[110] bg-[color:var(--overlay-scrim)] backdrop-blur-[3px] ${className}`}
      {...props}
    />
  );
}

export function DialogContent({
  children,
  title,
  description,
  className = "",
  testId,
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-testid={testId}
        {...(description ? {} : { "aria-describedby": undefined })}
        className={`fixed left-1/2 top-1/2 z-[120] flex max-h-[min(90vh,720px)] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-overlay shadow-overlay focus:outline-none ${className}`}
      >
        <div className="border-b border-[color:var(--border-subtle)] px-sp-8 py-sp-6">
          <DialogPrimitive.Title
            className="text-fg font-semibold"
            style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
          >
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description
              className="mt-sp-3 text-fg-muted"
              style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
            >
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
