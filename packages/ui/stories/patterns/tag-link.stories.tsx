import type { StoryDefault } from "@ladle/react";
import { TagLink } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Tag link",
  parameters: { subject: ["TagLink"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <div className="flex flex-wrap gap-2">
    <TagLink count="12" link={<a href="#reading" />} name="Reading" />
    <TagLink count="1,204" link={<a href="#work" />} name="Work" />
    <TagLink count="3" link={<a href="#long" />} name="A tag name that is far too long to fit in one badge and is cut off" />
  </div>
);
