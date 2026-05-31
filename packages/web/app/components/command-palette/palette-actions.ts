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
}

/** Default palette actions when the query is empty (proto PaletteApp.jsx). */
export const PALETTE_ACTIONS: PaletteActionDef[] = [
  {
    id: "new-bookmark",
    groupKey: "command_palette.group.create",
    titleKey: "command_palette.action.new_bookmark",
    hint: "C",
  },
  {
    id: "new-folder",
    groupKey: "command_palette.group.create",
    titleKey: "command_palette.action.new_folder",
    hint: "F",
  },
  {
    id: "new-tag",
    groupKey: "command_palette.group.create",
    titleKey: "command_palette.action.new_tag",
  },
  {
    id: "go-bookmarks",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_bookmarks",
    path: "/",
  },
  {
    id: "go-folders",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_folders",
    path: "/folders",
  },
  {
    id: "go-tags",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_tags",
    path: "/tags",
  },
  {
    id: "go-settings",
    groupKey: "command_palette.group.go_to",
    titleKey: "command_palette.action.go_settings",
    path: "/settings",
  },
  {
    id: "switch-workspace",
    groupKey: "command_palette.group.workspace",
    titleKey: "command_palette.action.switch_workspace",
    hint: "⌥W",
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
