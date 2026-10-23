import type { StoryDefault } from "@ladle/react";
import { BulkBar, BulkBarButton, PinIcon, Trash2Icon } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Bulk bar",
  parameters: { subject: ["BulkBar", "BulkBarButton"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <BulkBar
    actions={[
      { id: "pin", label: "Pin", icon: <PinIcon aria-hidden="true" />, onSelect: () => undefined },
      { id: "delete", label: "Delete", icon: <Trash2Icon aria-hidden="true" />, destructive: true, onSelect: () => undefined },
    ]}
    clear={{ label: "Clear selection", onClear: () => undefined }}
    count="14 selected"
    label="Selected bookmarks"
  >
    <BulkBarButton onClick={() => undefined}>Select all 120 matching</BulkBarButton>
  </BulkBar>
);

export const Running = (): React.ReactElement => (
  <BulkBar
    actions={[
      { id: "pin", label: "Pin", loading: true, onSelect: () => undefined },
      { id: "delete", label: "Delete", destructive: true, onSelect: () => undefined },
    ]}
    busy
    clear={{ label: "Clear selection", onClear: () => undefined }}
    count="14 selected"
    label="Selected bookmarks"
  />
);
