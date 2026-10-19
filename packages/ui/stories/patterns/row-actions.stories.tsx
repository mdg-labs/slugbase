import type { StoryDefault } from "@ladle/react";
import { RowActions } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Row actions",
  parameters: { subject: ["RowActions"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <RowActions
    actions={[
      { id: "role", label: "Change role", onSelect: () => undefined },
      { id: "remove", label: "Remove", destructive: true, onSelect: () => undefined },
    ]}
    label="Actions for Ada"
  />
);
