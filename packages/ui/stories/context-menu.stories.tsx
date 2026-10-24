import type { StoryDefault } from "@ladle/react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuPopup,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../src/index.ts";

export default {
  title: "Context menu",
  parameters: {
    subject: [
      "ContextMenu",
      "ContextMenuCheckboxItem",
      "ContextMenuGroup",
      "ContextMenuGroupLabel",
      "ContextMenuItem",
      "ContextMenuLinkItem",
      "ContextMenuPopup",
      "ContextMenuRadioGroup",
      "ContextMenuRadioItem",
      "ContextMenuSeparator",
      "ContextMenuShortcut",
      "ContextMenuSub",
      "ContextMenuSubPopup",
      "ContextMenuSubTrigger",
      "ContextMenuTrigger",
    ],
  },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <ContextMenu>
    <ContextMenuTrigger className="rounded-lg border p-8">Right click here</ContextMenuTrigger>
    <ContextMenuPopup aria-label="Actions for Example">
      <ContextMenuItem>
        Edit
        <ContextMenuShortcut>E</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuLinkItem href="https://example.com">Open</ContextMenuLinkItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
    </ContextMenuPopup>
  </ContextMenu>
);

export const Choices = (): React.ReactElement => (
  <ContextMenu>
    <ContextMenuTrigger className="rounded-lg border p-8">Right click here</ContextMenuTrigger>
    <ContextMenuPopup aria-label="View options">
      <ContextMenuGroup>
        <ContextMenuGroupLabel>Show</ContextMenuGroupLabel>
        <ContextMenuCheckboxItem defaultChecked>Slugs</ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem variant="switch">Tags</ContextMenuCheckboxItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuRadioGroup defaultValue="grid">
        <ContextMenuRadioItem value="grid">Grid</ContextMenuRadioItem>
        <ContextMenuRadioItem value="table">Table</ContextMenuRadioItem>
      </ContextMenuRadioGroup>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Sort by</ContextMenuSubTrigger>
        <ContextMenuSubPopup>
          <ContextMenuItem>Recent</ContextMenuItem>
          <ContextMenuItem>Title</ContextMenuItem>
        </ContextMenuSubPopup>
      </ContextMenuSub>
    </ContextMenuPopup>
  </ContextMenu>
);
