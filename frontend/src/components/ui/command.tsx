"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { type DialogProps } from "@radix-ui/react-dialog"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Dialog, DialogPortal, DialogOverlay } from "@/components/ui/dialog"

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-1 text-fg-0 shadow-lg",
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

interface CommandDialogProps extends DialogProps {
  /** Disable cmdk's built-in filtering (e.g. for async search) */
  shouldFilter?: boolean
  /** Controlled cmdk value (selected row) for keyboard shortcuts */
  commandValue?: string
  onCommandValueChange?: (value: string) => void
  onCommandKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
}

const CommandDialog = ({
  children,
  shouldFilter = true,
  commandValue,
  onCommandValueChange,
  onCommandKeyDown,
  ...props
}: CommandDialogProps) => {
  return (
    <Dialog {...props}>
      <DialogPortal>
        <DialogOverlay className="z-50 bg-[rgba(0,0,0,0.55)] backdrop-blur-[4px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-[14vh] z-[51] w-[min(640px,92vw)] max-w-[640px] -translate-x-1/2 gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search bookmarks, folders, and navigation
          </DialogPrimitive.Description>
          <Command
            shouldFilter={shouldFilter}
            value={commandValue}
            onValueChange={onCommandValueChange}
            onKeyDown={onCommandKeyDown}
            className={cn(
              "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-fg-3",
              "[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-1.5 [&_[cmdk-group]]:pb-1.5",
              "[&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4",
              "[&_[cmdk-input]]:min-h-0 [&_[cmdk-input]]:text-sm",
              "[&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:px-2.5 [&_[cmdk-item]]:py-2 [&_[cmdk-item]]:text-[13px] [&_[cmdk-item]_svg]:h-[15px] [&_[cmdk-item]_svg]:w-[15px]"
            )}
          >
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div
    className="flex items-center gap-2.5 border-b border-border px-3.5 py-3"
    cmdk-input-wrapper=""
  >
    <Search className="h-4 w-4 shrink-0 text-fg-2" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex w-full flex-1 rounded-none border-0 bg-transparent py-0.5 pl-0 text-sm text-fg-0 outline-none placeholder:text-fg-3 disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none",
        className
      )}
      {...props}
    />
    <span className="kbd shrink-0 rounded border border-border bg-bg-3 px-1.5 py-0.5 font-mono text-[10.5px] leading-snug text-fg-2">
      esc
    </span>
  </div>
))

CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[50vh] overflow-y-auto overflow-x-hidden p-1.5", className)}
    {...props}
  />
))

CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-6 text-center text-sm text-fg-2"
    {...props}
  />
))

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn("overflow-hidden text-fg-0", className)}
    {...props}
  />
))

CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border-soft", className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-fg-0 outline-none transition-colors",
      "data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent-bg data-[selected=true]:text-fg-0 data-[disabled=true]:opacity-50",
      "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-fg-2 data-[selected=true]:[&_svg]:text-accent-hi",
      className
    )}
    {...props}
  />
))

CommandItem.displayName = CommandPrimitive.Item.displayName

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-fg-3",
        className
      )}
      {...props}
    />
  )
}
CommandShortcut.displayName = "CommandShortcut"

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
