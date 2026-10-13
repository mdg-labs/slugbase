import type { StoryDefault } from "@ladle/react";
import { Skeleton } from "../src/index.ts";

export default {
  title: "Skeleton",
  parameters: { subject: ["Skeleton"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <div aria-busy="true" className="flex flex-col gap-2">
    <Skeleton className="h-4 w-48" />
    <Skeleton className="h-4 w-64" />
    <Skeleton className="h-4 w-32" />
  </div>
);
