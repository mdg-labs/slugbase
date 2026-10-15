import type { StoryDefault } from "@ladle/react";
import { InlineNote } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Inline note",
  parameters: { subject: ["InlineNote"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <InlineNote>The setup token was printed to the server log when the server started.</InlineNote>
);

export const WithTitle = (): React.ReactElement => (
  <InlineNote title="Where is the token?">Look for the line that starts with the product name in the log of the server.</InlineNote>
);
