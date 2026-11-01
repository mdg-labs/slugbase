import { XIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerDescription,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "../components/ui/drawer.tsx";
import { useIsMobile } from "../hooks/use-media-query.ts";

export interface FormOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /**
   * Controls that belong with the title, such as an action on the form as a whole. They stand in the header after the title and the description, not
   * inside the description, so they are not what assistive technology reads as the overlay's description and may hold block content.
   */
  headerAction?: ReactNode;
  /** The name of the button that closes the overlay. */
  closeLabel: string;
  /** The form: its fields and its own submit and cancel buttons. */
  children: ReactNode;
}

/**
 * A form over the page (doc 03 `form-overlay`), for an action that needs a few fields without leaving the page: a
 * coss Dialog, and a bottom Drawer below the `md` breakpoint.
 */
export function FormOverlay({ open, onOpenChange, title, description, headerAction, closeLabel, children }: FormOverlayProps): ReactElement {
  const narrow = useIsMobile();
  if (narrow) {
    return (
      <Drawer onOpenChange={onOpenChange} open={open}>
        <DrawerPopup data-slot="form-overlay">
          <DrawerHeader className="pe-14">
            <DrawerTitle>{title}</DrawerTitle>
            {description === undefined ? null : <DrawerDescription>{description}</DrawerDescription>}
            {headerAction === undefined ? null : <div data-slot="form-overlay-header-action">{headerAction}</div>}
          </DrawerHeader>
          <DrawerPanel>{children}</DrawerPanel>
          <DrawerClose aria-label={closeLabel} className="absolute end-2 top-2 z-1" render={<Button size="icon" variant="ghost" />}>
            <XIcon aria-hidden="true" />
          </DrawerClose>
        </DrawerPopup>
      </Drawer>
    );
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup closeProps={{ "aria-label": closeLabel }} data-slot="form-overlay">
        <DialogHeader className="pe-14">
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
          {headerAction === undefined ? null : <div data-slot="form-overlay-header-action">{headerAction}</div>}
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
