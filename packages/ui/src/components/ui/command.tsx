"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.ts";
import { Dialog, DialogPopup, DialogTrigger } from "./dialog.tsx";
import { KbdGroup } from "./kbd.tsx";

export const CommandDialog: typeof Dialog = Dialog;

export const CommandDialogTrigger: typeof DialogTrigger = DialogTrigger;

export function CommandDialogPopup({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof DialogPopup>, "showCloseButton">): React.ReactElement {
  return (
    <DialogPopup
      className={cn(
        "max-w-xl overflow-hidden rounded-2xl **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-1",
        className,
      )}
      data-slot="command-dialog-popup"
      showCloseButton={false}
      {...props}
    >
      {children}
    </DialogPopup>
  );
}

export type CommandProps = Omit<AutocompletePrimitive.Root.Props<string>, "inline" | "open" | "items" | "filteredItems" | "filter">;

/**
 * The command surface: an input over a list whose options the caller renders and filters itself. It is an
 * inline Base UI autocomplete that is always open, so the list is part of the surface and not a popup.
 */
export function Command({ autoHighlight = "always", ...props }: CommandProps): React.ReactElement {
  return <AutocompletePrimitive.Root autoHighlight={autoHighlight} inline open {...props} />;
}

export function CommandInput({
  className,
  startAddon,
  ...props
}: AutocompletePrimitive.Input.Props & { startAddon?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
      <SearchIcon aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground sm:size-4" />
      {startAddon}
      <AutocompletePrimitive.Input
        autoFocus
        className={cn(
          "h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/72 sm:text-sm",
          className,
        )}
        data-slot="command-input"
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: AutocompletePrimitive.List.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.List
      className={cn("max-h-[min(60dvh,24rem)] min-h-0 overflow-y-auto overscroll-contain p-1.5 outline-none", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

export function CommandGroup({ className, ...props }: AutocompletePrimitive.Group.Props): React.ReactElement {
  return <AutocompletePrimitive.Group className={cn("mb-1 last:mb-0", className)} data-slot="command-group" {...props} />;
}

export function CommandGroupLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.GroupLabel
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", className)}
      data-slot="command-group-label"
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: AutocompletePrimitive.Item.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.Item
      className={cn(
        "flex min-h-9 cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-base outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-8 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: AutocompletePrimitive.Separator.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.Separator className={cn("mx-2 my-1 h-px bg-border", className)} data-slot="command-separator" {...props} />
  );
}

export function CommandShortcut({ className, ...props }: React.ComponentProps<typeof KbdGroup>): React.ReactElement {
  return <KbdGroup className={cn("ms-auto shrink-0", className)} data-slot="command-shortcut" {...props} />;
}

export function CommandPanel({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return <div className={cn("flex min-h-0 flex-1 flex-col", className)} data-slot="command-panel" {...props} />;
}

export function CommandFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2.5 text-muted-foreground text-xs max-sm:hidden", className)}
      data-slot="command-footer"
      {...props}
    />
  );
}
