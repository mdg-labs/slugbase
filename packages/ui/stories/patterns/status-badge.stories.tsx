import type { StoryDefault } from "@ladle/react";
import { StatusBadge } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Status badge",
  parameters: { subject: ["StatusBadge"] },
} satisfies StoryDefault;

export const Variants = (): React.ReactElement => (
  <div className="flex flex-wrap gap-2">
    <StatusBadge>Neutral</StatusBadge>
    <StatusBadge variant="info">This device</StatusBadge>
    <StatusBadge variant="success">Verified</StatusBadge>
    <StatusBadge variant="warning">Pending verification</StatusBadge>
    <StatusBadge variant="error">Disabled</StatusBadge>
  </div>
);
