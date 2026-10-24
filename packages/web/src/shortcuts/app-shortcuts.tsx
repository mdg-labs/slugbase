import { useShortcut } from "@slugbase/ui";
import { ShortcutSheet, type ShortcutSheetGroup } from "@slugbase/ui/patterns";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCanSaveBookmarks } from "../bookmarks/can-save-bookmarks.ts";
import { useBookmarkModal } from "../bookmarks/modal-search.ts";
import { GoShortcuts } from "./go-shortcuts.tsx";

/**
 * The shortcuts of every page of the app (doc 03 section 14): `C` opens the New bookmark modal, `G` then `H` or `B` goes to
 * Home or Bookmarks, and `?` opens the sheet that lists the shortcuts, in the language of the page. They are single-key
 * shortcuts, which the account can switch off, and the sheet lists those the app has.
 */
export function AppShortcuts(): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const modal = useBookmarkModal();
  const canSave = useCanSaveBookmarks();
  useShortcut({ key: "?" }, () => {
    setOpen(true);
  });
  useShortcut({ key: "c" }, (event) => {
    if (canSave) {
      event.preventDefault();
      modal.openNew();
    }
  });

  const keys = { enter: t("shortcuts.key.enter"), ctrl: t("shortcuts.key.ctrl"), esc: t("shortcuts.key.esc") };
  const groups: readonly ShortcutSheetGroup[] = [
    {
      id: "app",
      title: t("shortcuts.group.app"),
      shortcuts: [
        { id: "new", label: t("shortcuts.item.newBookmark"), keys: [["C"]] },
        { id: "home", label: t("shortcuts.item.goHome"), keys: [["G", "H"]], sequence: true },
        { id: "bookmarks", label: t("shortcuts.item.goBookmarks"), keys: [["G", "B"]], sequence: true },
        { id: "help", label: t("shortcuts.item.help"), keys: [["?"]] },
      ],
    },
    {
      id: "list",
      title: t("shortcuts.group.list"),
      shortcuts: [
        { id: "move", label: t("shortcuts.item.move"), keys: [["J"], ["K"], ["↑"], ["↓"]] },
        { id: "open", label: t("shortcuts.item.open"), keys: [[keys.enter]] },
        { id: "openNewTab", label: t("shortcuts.item.openNewTab"), keys: [[keys.ctrl, keys.enter], ["⌘", keys.enter]] },
        { id: "edit", label: t("shortcuts.item.edit"), keys: [["E"]] },
        { id: "pin", label: t("shortcuts.item.pin"), keys: [["P"]] },
        { id: "select", label: t("shortcuts.item.select"), keys: [["X"]] },
        { id: "selectAll", label: t("shortcuts.item.selectAll"), keys: [["⇧", "A"]] },
        { id: "view", label: t("shortcuts.item.toggleView"), keys: [["V"]] },
        { id: "escape", label: t("shortcuts.item.escape"), keys: [[keys.esc]] },
      ],
    },
  ];

  return (
    <>
      <GoShortcuts />
      <ShortcutSheet
        closeLabel={t("shortcuts.close")}
        description={t("shortcuts.description")}
        groups={groups}
        onOpenChange={setOpen}
        open={open}
        thenLabel={t("shortcuts.then")}
        title={t("shortcuts.title")}
      />
    </>
  );
}
