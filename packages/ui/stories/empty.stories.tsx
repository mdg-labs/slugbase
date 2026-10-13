import type { StoryDefault } from "@ladle/react";
import { InboxIcon } from "lucide-react";
import { Button, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../src/index.ts";

export default {
  title: "Empty",
  parameters: { subject: ["Empty", "EmptyContent", "EmptyDescription", "EmptyHeader", "EmptyMedia", "EmptyTitle"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Empty>
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <InboxIcon aria-hidden="true" />
      </EmptyMedia>
      <EmptyTitle>No bookmarks yet</EmptyTitle>
      <EmptyDescription>Add your first bookmark to see it here.</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button>Add bookmark</Button>
    </EmptyContent>
  </Empty>
);
