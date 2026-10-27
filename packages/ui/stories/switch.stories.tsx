import type { StoryDefault } from "@ladle/react";
import { Switch } from "../src/index.ts";

export default {
  title: "Switch",
  parameters: { subject: ["Switch"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <div className="flex items-center gap-4">
    <Switch aria-label="Forwarding on" defaultChecked />
    <Switch aria-label="Forwarding off" />
    <Switch aria-label="Forwarding unavailable" disabled />
  </div>
);
