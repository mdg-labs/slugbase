import { FOLDER_ICON_COMPONENTS, FolderIcon } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";

// The classes are written out so that Tailwind finds them: they name the --folder-N theme tokens (doc 03 "Theme tokens").
const COLOR_TEXT: Readonly<Record<number, string>> = {
  1: "text-folder-1",
  2: "text-folder-2",
  3: "text-folder-3",
  4: "text-folder-4",
  5: "text-folder-5",
  6: "text-folder-6",
  7: "text-folder-7",
  8: "text-folder-8",
};

const COLOR_BACKGROUND: Readonly<Record<number, string>> = {
  1: "bg-folder-1",
  2: "bg-folder-2",
  3: "bg-folder-3",
  4: "bg-folder-4",
  5: "bg-folder-5",
  6: "bg-folder-6",
  7: "bg-folder-7",
  8: "bg-folder-8",
};

/** The class that sets a text colour to the folder token `color`; the first token for a number outside 1 to 8. */
export function folderTextClass(color: number): string {
  return COLOR_TEXT[color] ?? "text-folder-1";
}

/** The class that sets a background to the folder token `color`; the first token for a number outside 1 to 8. */
export function folderBackgroundClass(color: number): string {
  return COLOR_BACKGROUND[color] ?? "bg-folder-1";
}

/** The icon component of a stored icon name; the plain folder for a name outside the curated set. */
export function folderIconOf(name: string): (typeof FOLDER_ICON_COMPONENTS)[string] {
  return FOLDER_ICON_COMPONENTS[name] ?? FolderIcon;
}

/** A folder's icon in its colour, decorative: the folder's name beside it says which folder it is. */
export function FolderGlyph({ icon, color }: { readonly icon: string; readonly color: number }): ReactElement {
  const Icon = folderIconOf(icon);
  return (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
      <Icon className={`size-4.5 ${folderTextClass(color)}`} />
    </span>
  );
}
