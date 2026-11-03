import type { StoryDefault } from "@ladle/react";
import { GroupedResults } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/GroupedResults",
  parameters: { subject: ["GroupedResults"] },
} satisfies StoryDefault;

const duplicates = (
  <ul className="flex flex-col gap-1 text-sm">
    <li>Example site (https://example.com/)</li>
    <li>Docs (https://example.com/docs)</li>
  </ul>
);

export const Default = (): React.ReactElement => (
  <GroupedResults
    groups={[
      { id: "duplicate", label: "Already in your workspace", count: 2, children: duplicates },
      { id: "limit", label: "No room left", count: 1, children: <p className="text-sm">Old page (https://example.com/old)</p> },
    ]}
  />
);

export const SeveralOpen = (): React.ReactElement => (
  <GroupedResults
    defaultOpen={["duplicate", "limit"]}
    groups={[
      { id: "duplicate", label: "Already in your workspace", count: 2, children: duplicates },
      { id: "limit", label: "No room left", count: 1, children: <p className="text-sm">Old page (https://example.com/old)</p> },
    ]}
  />
);

export const EmptyGroupsLeftOut = (): React.ReactElement => (
  <GroupedResults
    groups={[
      { id: "duplicate", label: "Already in your workspace", count: 0, children: null },
      { id: "failed", label: "Address not valid", count: 1, countLabel: "1", children: <p className="text-sm">Bookmarklet (javascript:void(0))</p> },
    ]}
  />
);
