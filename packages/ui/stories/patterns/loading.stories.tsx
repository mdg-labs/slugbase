import type { StoryDefault } from "@ladle/react";
import { Skeleton } from "../../src/index.ts";
import { Loading } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Loading",
  parameters: { subject: ["Loading"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <Loading label="Loading" />;

export const CustomShape = (): React.ReactElement => (
  <Loading label="Loading bookmarks">
    <Skeleton className="h-24 w-full" />
  </Loading>
);
