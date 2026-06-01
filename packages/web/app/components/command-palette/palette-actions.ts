export type PaletteActionId =
  | "new-bookmark"
  | "new-folder"
  | "new-tag"
  | "go-bookmarks"
  | "go-folders"
  | "go-tags"
  | "go-settings"
  | "switch-workspace";

export type PaletteActionGroupKey =
  | "command_palette.group.create"
  | "command_palette.group.go_to"
  | "command_palette.group.workspace";

export interface PaletteActionDef {
  id: PaletteActionId;
  groupKey: PaletteActionGroupKey;
  titleKey: string;
  hint?: string;
  path?: string;
  /** SVG path `d` attribute for the 15×15 action icon. */
  iconPath?: string;
}

/** Default palette actions when the query is empty (proto PaletteApp.jsx). */
export const PALETTE_ACTIONS: PaletteActionDef[] = [
  {
    id: "new-bookmark",
    groupKey: "command_palette.group.create",
    titleKey: "command_palette.action.new_bookmark",
    hint: "C",
    iconPath: "M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z",
  },
  {
    id: "new-folder",
    groupKey: "command_palette.group.create",
    titleKey: "command_palette.action.new_folder",
    hint: "F",
    iconPath: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z",
  },
  {
    id: "new-tag",
    groupKey: "command_palette.group.create",
    titleKey: "command_palette.action.new_tag",
    iconPath: "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01",
  },
  {
    id: "go-bookmarks",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_bookmarks",
    path: "/bookmarks",
    iconPath: "M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z",
  },
  {
    id: "go-folders",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_folders",
    path: "/folders",
    iconPath: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z",
  },
  {
    id: "go-tags",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_tags",
    path: "/tags",
    iconPath: "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01",
  },
  {
    id: "go-settings",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_settings",
    path: "/settings/account",
    iconPath: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  },
  {
    id: "switch-workspace",
    groupKey: "command_palette.group.workspace",
    titleKey: "command_palette.action.switch_workspace",
    hint: "⌥W",
    iconPath: "M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z",
  },
];

export const PALETTE_ACTION_GROUPS: PaletteActionGroupKey[] = [
  "command_palette.group.create",
  "command_palette.group.go_to",
  "command_palette.group.workspace",
];

/** Single-key shortcuts when the palette is open with an empty query. */
export const PALETTE_SHORTCUTS: Partial<Record<string, PaletteActionId>> = {
  c: "new-bookmark",
  f: "new-folder",
};
