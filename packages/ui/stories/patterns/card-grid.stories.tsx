import type { StoryDefault } from "@ladle/react";
import { Trash2Icon, PencilIcon } from "lucide-react";
import { CardGrid, CardGridItem } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Card grid",
  parameters: { subject: ["CardGrid", "CardGridItem"] },
} satisfies StoryDefault;

const ACTIONS = [
  { id: "edit", label: "Edit", icon: <PencilIcon aria-hidden="true" />, onSelect: () => undefined },
  { id: "delete", label: "Delete", icon: <Trash2Icon aria-hidden="true" />, destructive: true, onSelect: () => undefined },
];

export const Default = (): React.ReactElement => (
  <CardGrid label="Bookmarks">
    <CardGridItem actions={ACTIONS} actionsLabel="Actions for Example docs" href="https://example.com/docs" host="example.com" selectLabel="Select Example docs" subtitle="example.com" title="Example docs">
      <p className="text-muted-foreground text-xs">142 opens · 2 h ago</p>
    </CardGridItem>
    <CardGridItem
      actions={ACTIONS}
      actionsLabel="Actions for A very long title that runs over two lines of the card and is cut off after them"
      href="https://example.org/read"
      host="example.com"
      selectLabel="Select the long one"
      subtitle="example.org"
      title="A very long title that runs over two lines of the card and is cut off after them"
    />
  </CardGrid>
);
