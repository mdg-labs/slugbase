import type { StoryDefault } from "@ladle/react";
import { UsageMeter } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Usage meter",
  parameters: { subject: ["UsageMeter"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <UsageMeter label="reading" max={20} value={5} valueLabel="5 bookmarks" />;

export const Full = (): React.ReactElement => <UsageMeter label="reading" max={20} value={20} valueLabel="20 bookmarks" />;

export const Empty = (): React.ReactElement => <UsageMeter label="reading" max={20} value={0} valueLabel="No bookmarks" />;
