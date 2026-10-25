import type { StoryDefault } from "@ladle/react";
import { Toggle } from "../src/index.ts";

export default {
  title: "Toggle",
  parameters: { subject: ["Toggle"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <Toggle>Pinned</Toggle>;

export const Outline = (): React.ReactElement => <Toggle variant="outline">Pinned</Toggle>;

export const Pressed = (): React.ReactElement => (
  <Toggle defaultPressed variant="outline">
    Pinned
  </Toggle>
);
