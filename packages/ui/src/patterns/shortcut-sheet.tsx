import type { ReactElement, ReactNode } from "react";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.tsx";
import { Kbd, KbdGroup } from "../components/ui/kbd.tsx";

export interface ShortcutSheetItem {
  /** Keys the shortcut. */
  id: string;
  /** What the shortcut does, in the language of the page. */
  label: string;
  /** The ways to press it: each is a list of keys pressed together, or one after the other when `sequence` is set. */
  keys: readonly (readonly string[])[];
  /** Whether the keys of each way are pressed one after the other. */
  sequence?: boolean;
}

export interface ShortcutSheetGroup {
  id: string;
  title: string;
  shortcuts: readonly ShortcutSheetItem[];
}

export interface ShortcutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** The name of the button that closes the sheet. */
  closeLabel: string;
  /** The word between the keys of a sequence, as in "G then H". */
  thenLabel: string;
  groups: readonly ShortcutSheetGroup[];
}

function Keys({ item, thenLabel }: { item: ShortcutSheetItem; thenLabel: string }): ReactElement {
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {item.keys.map((way, index) => (
        <span className="flex items-center gap-2" key={way.join("+")}>
          {index === 0 ? null : (
            <span aria-hidden="true" className="text-muted-foreground text-xs">
              /
            </span>
          )}
          <KbdGroup>
            {way.map((key, position) => (
              <span className="flex items-center gap-1" key={key}>
                {position === 0 || item.sequence !== true ? null : <span className="text-muted-foreground text-xs">{thenLabel}</span>}
                <Kbd className="font-mono" translate="no">
                  {key}
                </Kbd>
              </span>
            ))}
          </KbdGroup>
        </span>
      ))}
    </span>
  );
}

/**
 * The sheet of keyboard shortcuts (doc 03 section 14): a coss Dialog that lists each group of shortcuts with their
 * keys in Kbd. The labels come from the caller, so the sheet is in the language of the page.
 */
export function ShortcutSheet({ open, onOpenChange, title, description, closeLabel, thenLabel, groups }: ShortcutSheetProps): ReactElement {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup closeProps={{ "aria-label": closeLabel }} data-slot="shortcut-sheet">
        <DialogHeader className="pe-14">
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section aria-labelledby={`shortcut-group-${group.id}`} key={group.id}>
                <h3 className="mb-2 font-medium text-sm" id={`shortcut-group-${group.id}`}>
                  {group.title}
                </h3>
                <dl className="flex flex-col divide-y divide-border">
                  {group.shortcuts.map((item) => (
                    <div className="flex items-center justify-between gap-4 py-2 text-sm" key={item.id}>
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd>
                        <Keys item={item} thenLabel={thenLabel} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
