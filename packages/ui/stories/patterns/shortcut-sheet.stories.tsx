import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "../../src/index.ts";
import { ShortcutSheet, type ShortcutSheetGroup } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Shortcut sheet",
  parameters: { subject: ["ShortcutSheet"] },
} satisfies StoryDefault;

const GROUPS: readonly ShortcutSheetGroup[] = [
  {
    id: "app",
    title: "Anywhere in the app",
    shortcuts: [
      { id: "new", label: "New bookmark", keys: [["C"]] },
      { id: "home", label: "Go to Home", keys: [["G", "H"]], sequence: true },
      { id: "help", label: "Show this list", keys: [["?"]] },
    ],
  },
  {
    id: "list",
    title: "In the bookmark list",
    shortcuts: [
      { id: "move", label: "Move focus to the next or previous bookmark", keys: [["J"], ["K"], ["↑"], ["↓"]] },
      { id: "tab", label: "Open the focused bookmark in a new tab", keys: [["Ctrl", "Enter"], ["⌘", "Enter"]] },
    ],
  },
];

export const Default = (): React.ReactElement => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        Keyboard shortcuts
      </Button>
      <ShortcutSheet
        closeLabel="Close the shortcut list"
        description="Single-key shortcuts work anywhere except in a text field or inside an open dialog, menu or list box."
        groups={GROUPS}
        onOpenChange={setOpen}
        open={open}
        thenLabel="then"
        title="Keyboard shortcuts"
      />
    </>
  );
};

export const Open = (): React.ReactElement => (
  <>
    <p>The page behind the sheet.</p>
    <ShortcutSheet closeLabel="Close the shortcut list" groups={GROUPS} onOpenChange={() => undefined} open thenLabel="then" title="Keyboard shortcuts" />
  </>
);
