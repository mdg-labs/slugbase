import type { StoryDefault } from "@ladle/react";
import { ToggleGroup, ToggleGroupItem, ToggleGroupSeparator } from "../src/index.ts";

export default {
  title: "Toggle group",
  parameters: { subject: ["ToggleGroup", "ToggleGroupItem", "ToggleGroupSeparator"] },
} satisfies StoryDefault;

export const Single = (): React.ReactElement => (
  <ToggleGroup aria-label="View" defaultValue={["grid"]} variant="outline">
    <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
    <ToggleGroupItem value="table">Table</ToggleGroupItem>
  </ToggleGroup>
);

export const Multiple = (): React.ReactElement => (
  <ToggleGroup aria-label="Filters" defaultValue={["pinned"]} multiple size="sm" variant="outline">
    <ToggleGroupItem value="pinned">Pinned</ToggleGroupItem>
    <ToggleGroupItem value="slug">Has slug</ToggleGroupItem>
    <ToggleGroupItem value="forwarding">Forwarding</ToggleGroupItem>
  </ToggleGroup>
);

export const Separated = (): React.ReactElement => (
  <ToggleGroup aria-label="Text style" multiple>
    <ToggleGroupItem value="bold">Bold</ToggleGroupItem>
    <ToggleGroupSeparator />
    <ToggleGroupItem value="italic">Italic</ToggleGroupItem>
  </ToggleGroup>
);
