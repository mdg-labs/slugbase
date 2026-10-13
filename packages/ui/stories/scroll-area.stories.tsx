import type { StoryDefault } from "@ladle/react";
import { ScrollArea, ScrollAreaPrimitive, ScrollBar } from "../src/index.ts";

export default {
  title: "Scroll Area",
  parameters: { subject: ["ScrollArea", "ScrollBar"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <ScrollArea className="h-40 w-64 rounded-lg border">
    <ul className="p-3">
      {Array.from({ length: 30 }, (_, index) => (
        <li key={index}>Folder {index + 1}</li>
      ))}
    </ul>
  </ScrollArea>
);

export const Horizontal = (): React.ReactElement => (
  <ScrollArea className="w-64 rounded-lg border" scrollbarGutter>
    <p className="w-[40rem] p-3 whitespace-nowrap">A line that is wider than the area around it.</p>
  </ScrollArea>
);

export const Composed = (): React.ReactElement => (
  <ScrollAreaPrimitive.Root className="h-40 w-64 rounded-lg border">
    <ScrollAreaPrimitive.Viewport className="h-full">
      <ul className="p-3">
        {Array.from({ length: 30 }, (_, index) => (
          <li key={index}>Tag {index + 1}</li>
        ))}
      </ul>
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
  </ScrollAreaPrimitive.Root>
);
