import type { StoryDefault } from "@ladle/react";
import { Button, Spinner, SpinnerLabelProvider } from "../src/index.ts";

export default {
  title: "Spinner",
  parameters: { subject: ["Spinner", "SpinnerLabelProvider"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <Spinner />;

export const Large = (): React.ReactElement => <Spinner className="size-8" />;

export const Labelled = (): React.ReactElement => (
  <SpinnerLabelProvider label="Loading">
    <Button loading>Sign in</Button>
  </SpinnerLabelProvider>
);
