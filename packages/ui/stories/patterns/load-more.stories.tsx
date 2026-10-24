import type { StoryDefault } from "@ladle/react";
import { LoadMore } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Load more",
  parameters: { subject: ["LoadMore"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <LoadMore
    count="Showing 48 of 1,234"
    hasMore
    loadMoreLabel="Load more"
    onLoadMore={() => undefined}
    pageSize={{
      label: "Per load",
      value: "48",
      options: [
        { value: "24", label: "24" },
        { value: "48", label: "48" },
        { value: "96", label: "96" },
      ],
      onValueChange: () => undefined,
    }}
  />
);

export const AllShown = (): React.ReactElement => <LoadMore count="Showing 3 of 3" hasMore={false} loadMoreLabel="Load more" onLoadMore={() => undefined} />;
