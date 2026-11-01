import { XIcon } from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
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

const MODAL_POPUPS = '[role="dialog"]:not([aria-modal="false"])[data-open], [role="alertdialog"][data-open]';

/**
 * While the overlay is open, a Tab or Shift+Tab pressed with the focus on the page body, where it lands when the field that
 * held it is removed or clicked away from, goes into the overlay and not to the page behind it. The popup takes the focus and
 * its own Tab handling then decides the stop: a probe key goes through that handler, which sends Shift+Tab to the last stop,
 * and a Tab goes on from the popup to the first. Over it, another modal (the palette, a question) is left to itself.
 */
function useTabFromBody(popup: HTMLElement | null): void {
  useEffect(() => {
    if (popup === null) {
      return;
    }
    const overlay = popup;
    const document = overlay.ownerDocument;
    let probing = false;
    function onKeyDown(event: KeyboardEvent): void {
      if (probing || event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      const active = document.activeElement;
      if (active !== null && active !== document.body && active !== document.documentElement) {
        return;
      }
      const modals = document.querySelectorAll<HTMLElement>(MODAL_POPUPS);
      if (modals[modals.length - 1] !== overlay) {
        return;
      }
      overlay.focus({ preventScroll: true });
      const probe = new KeyboardEvent("keydown", { key: "Tab", shiftKey: event.shiftKey, bubbles: true, cancelable: true });
      probing = true;
      try {
        overlay.dispatchEvent(probe);
      } finally {
        probing = false;
      }
      if (probe.defaultPrevented) {
        event.preventDefault();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [popup]);
}

/**
 * A form over the page (doc 03 `form-overlay`), for an action that needs a few fields without leaving the page: a
 * coss Dialog, and a bottom Drawer below the `md` breakpoint.
 */
export function FormOverlay({ open, onOpenChange, title, description, headerAction, closeLabel, children }: FormOverlayProps): ReactElement {
  const narrow = useIsMobile();
  const [popup, setPopup] = useState<HTMLElement | null>(null);
  useTabFromBody(open ? popup : null);
  if (narrow) {
    return (
      <Drawer onOpenChange={onOpenChange} open={open}>
        <DrawerPopup data-slot="form-overlay" ref={setPopup}>
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
      <DialogPopup closeProps={{ "aria-label": closeLabel }} data-slot="form-overlay" ref={setPopup}>
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
