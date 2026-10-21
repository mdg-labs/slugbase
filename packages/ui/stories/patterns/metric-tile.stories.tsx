import type { StoryDefault } from "@ladle/react";
import { MetricTile } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Metric tile",
  parameters: { subject: ["MetricTile"] },
} satisfies StoryDefault;

export const Counts = (): React.ReactElement => (
  <div className="grid gap-4 sm:grid-cols-3">
    <MetricTile label="Accounts" value="1,204" />
    <MetricTile label="Workspaces" value="87" />
    <MetricTile label="Active sessions" value="312" />
  </div>
);
