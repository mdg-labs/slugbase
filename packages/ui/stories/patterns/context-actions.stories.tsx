import type { StoryDefault } from "@ladle/react";
import { ContextActions } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Context actions",
  parameters: { subject: ["ContextActions"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <ContextActions
    actions={[
      { id: "edit", label: "Edit", onSelect: () => undefined },
      { id: "delete", label: "Delete", destructive: true, onSelect: () => undefined },
    ]}
    className="rounded-lg border p-8"
    label="Actions for Example docs"
  >
    Right click here
  </ContextActions>
);
