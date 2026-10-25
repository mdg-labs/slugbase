import type { ReactElement, ReactNode } from "react";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.tsx";

export interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** The name of the button that closes the panel. */
  closeLabel: string;
  /** What the panel shows beside the page. */
  children: ReactNode;
}

/**
 * Detail that opens beside the page without leaving it (doc 03 `side-panel`): a coss Sheet from the end edge, named by its
 * title, scrolling its own content. Escape, the backdrop and the close button close it.
 */
export function SidePanel({ open, onOpenChange, title, description, closeLabel, children }: SidePanelProps): ReactElement {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup closeProps={{ "aria-label": closeLabel }}>
        <SheetHeader className="pe-14">
          <SheetTitle>{title}</SheetTitle>
          {description === undefined ? null : <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <SheetPanel>{children}</SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
