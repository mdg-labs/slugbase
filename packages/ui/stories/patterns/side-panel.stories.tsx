import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "../../src/index.ts";
import { SidePanel } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Side panel",
  parameters: { subject: ["SidePanel"] },
} satisfies StoryDefault;

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
        Preview
      </Button>
      <SidePanel closeLabel="Close" description="The newest bookmarks with this tag." onOpenChange={setOpen} open={open} title="reading">
        <p>Three bookmarks.</p>
      </SidePanel>
    </>
  );
};

export const Open = (): React.ReactElement => (
  <>
    <p>The page beside the panel.</p>
    <SidePanel closeLabel="Close" description="The newest bookmarks with this tag." onOpenChange={() => undefined} open title="reading">
      <p>Three bookmarks.</p>
    </SidePanel>
  </>
);
