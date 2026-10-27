import type { StoryDefault } from "@ladle/react";
import { SlugChip } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Slug chip",
  parameters: { subject: ["SlugChip"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <div className="flex flex-wrap gap-2">
    <SlugChip slug="docs" />
    <SlugChip slug="team-calendar" />
  </div>
);
