import type { StoryDefault } from "@ladle/react";
import { InboxIcon } from "lucide-react";
import { Button } from "../../src/index.ts";
import { EmptyState } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Empty state",
  parameters: { subject: ["EmptyState"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <EmptyState
    actions={<Button>Add bookmark</Button>}
    description="Add your first bookmark to see it here."
    headingLevel={1}
    icon={<InboxIcon aria-hidden="true" />}
    title="No bookmarks yet"
  />
);

export const TitleOnly = (): React.ReactElement => <EmptyState title="Nothing here" />;
