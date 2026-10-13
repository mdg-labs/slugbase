import type { StoryDefault } from "@ladle/react";
import { Separator } from "../src/index.ts";

export default {
  title: "Separator",
  parameters: { subject: ["Separator"] },
} satisfies StoryDefault;

export const Horizontal = (): React.ReactElement => (
  <div className="flex flex-col gap-3">
    <p>Above</p>
    <Separator />
    <p>Below</p>
  </div>
);

export const Vertical = (): React.ReactElement => (
  <div className="flex h-6 items-center gap-3">
    <span>Left</span>
    <Separator orientation="vertical" />
    <span>Right</span>
  </div>
);
