import type { StoryDefault } from "@ladle/react";
import { UnsavedGuard } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Unsaved guard",
  parameters: { subject: ["UnsavedGuard"] },
} satisfies StoryDefault;

export const Open = (): React.ReactElement => (
  <>
    <p>The form behind the dialog.</p>
    <UnsavedGuard
      description="Your changes to this bookmark are lost if you close it now."
      discardLabel="Discard changes"
      keepEditingLabel="Keep editing"
      onDiscard={() => undefined}
      onKeepEditing={() => undefined}
      open
      title="Discard your changes?"
    />
  </>
);
