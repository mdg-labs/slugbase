import type { StoryDefault } from "@ladle/react";
import { DangerZone } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Danger zone",
  parameters: { subject: ["DangerZone"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <DangerZone
    items={[{ id: "leave", title: "Leave workspace", description: "You lose access to everything you reached through it.", actionLabel: "Leave workspace", onSelect: () => undefined }]}
    title="Danger zone"
  />
);

export const Blocked = (): React.ReactElement => (
  <DangerZone
    items={[
      {
        id: "leave",
        title: "Leave workspace",
        description: "You are the last owner, so you cannot leave yet. Transfer ownership first.",
        actionLabel: "Leave workspace",
        onSelect: () => undefined,
        disabled: true,
      },
    ]}
    title="Danger zone"
  />
);
