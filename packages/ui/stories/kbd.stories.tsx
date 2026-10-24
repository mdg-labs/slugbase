import type { StoryDefault } from "@ladle/react";
import { Kbd, KbdGroup } from "../src/index.ts";

export default {
  title: "Kbd",
  parameters: { subject: ["Kbd", "KbdGroup"] },
} satisfies StoryDefault;

export const Key = (): React.ReactElement => <Kbd>?</Kbd>;

export const Combination = (): React.ReactElement => (
  <KbdGroup>
    <Kbd>Ctrl</Kbd>
    <Kbd>Enter</Kbd>
  </KbdGroup>
);
