import type { StoryDefault } from "@ladle/react";
import { Spinner } from "../src/index.ts";

export default {
  title: "Spinner",
  parameters: { subject: ["Spinner"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <Spinner />;

export const Large = (): React.ReactElement => <Spinner className="size-8" />;
