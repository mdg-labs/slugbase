import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/55 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  hideCloseButton?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideCloseButton, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-[640px] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-2)] p-6 text-[var(--fg-0)] shadow-[var(--shadow-lg)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        className
      )}
      {...props}
    >
      {children}
      {!hideCloseButton ? (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-[var(--fg-3)] opacity-90 transition-opacity hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] focus:ring-offset-2 focus:ring-offset-[var(--bg-2)] disabled:pointer-events-none">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight text-[var(--fg-0)]",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-[var(--fg-2)]", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

/** Alias for `Dialog` — mockup `.modal` shell (`styles.css` L685–714). */
const Modal = Dialog

type ModalContentProps = DialogContentProps & {
  /** 720px cap for large modals (share, bookmark, import). */
  wide?: boolean
}

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(({ className, children, hideCloseButton = true, wide, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 flex max-h-[86vh] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-1)] p-0 text-[var(--fg-0)] shadow-[var(--shadow-lg)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        wide ? "w-[min(720px,92vw)]" : "w-[min(620px,92vw)]",
        className
      )}
      {...props}
    >
      {children}
      {!hideCloseButton ? (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-[var(--fg-3)] opacity-90 transition-opacity hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] focus:ring-offset-2 focus:ring-offset-[var(--bg-1)] disabled:pointer-events-none">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPortal>
))
ModalContent.displayName = "ModalContent"

function ModalHead({
  title,
  icon: Icon,
  className,
}: {
  title: string
  icon?: LucideIcon
  className?: string
}) {
  return (
    <div
      className={cn(
        "modal-head flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-[18px] py-3.5",
        className
      )}
    >
      {Icon ? (
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-bg)] text-[var(--accent-hi)] ring-1 ring-inset ring-[var(--accent-ring)]">
          <Icon className="size-[13px]" strokeWidth={1.75} aria-hidden />
        </span>
      ) : null}
      <DialogPrimitive.Title asChild>
        <h3 className="m-0 text-sm font-semibold leading-none text-[var(--fg-0)]">
          {title}
        </h3>
      </DialogPrimitive.Title>
      <DialogPrimitive.Close
        type="button"
        className="close ml-auto rounded p-1 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        aria-label="Close"
      >
        <X className="size-3.5" />
      </DialogPrimitive.Close>
    </div>
  )
}

const ModalBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "modal-body min-h-0 flex-1 overflow-y-auto px-[18px] py-4",
      className
    )}
    {...props}
  />
)
ModalBody.displayName = "ModalBody"

const ModalFoot = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "modal-foot flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-[18px] py-3",
      className
    )}
    {...props}
  />
)
ModalFoot.displayName = "ModalFoot"

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
}
