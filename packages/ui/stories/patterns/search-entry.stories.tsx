import type { StoryDefault } from "@ladle/react";
import { SearchEntry } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Search entry",
  parameters: { subject: ["SearchEntry"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <div className="max-w-xl">
    <SearchEntry label="Search bookmarks, folders and tags" onClick={() => undefined} shortcut={["Ctrl", "K"]} />
  </div>
);
