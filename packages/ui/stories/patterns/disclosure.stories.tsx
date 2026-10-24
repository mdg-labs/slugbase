import type { StoryDefault } from "@ladle/react";
import { Disclosure } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Disclosure",
  parameters: { subject: ["Disclosure"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Disclosure label="More">
    <p>Optional fields go here.</p>
  </Disclosure>
);

export const Open = (): React.ReactElement => (
  <Disclosure defaultOpen label="More">
    <p>Optional fields go here.</p>
  </Disclosure>
);
