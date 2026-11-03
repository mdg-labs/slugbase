import type { StoryDefault } from "@ladle/react";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from "../src/index.ts";

export default {
  title: "Progress",
  parameters: { subject: ["Progress", "ProgressLabel", "ProgressTrack", "ProgressIndicator", "ProgressValue"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Progress value={40}>
    <ProgressLabel>Uploading</ProgressLabel>
    <ProgressTrack>
      <ProgressIndicator />
    </ProgressTrack>
  </Progress>
);

export const WithValue = (): React.ReactElement => (
  <Progress value={65}>
    <div className="flex justify-between">
      <ProgressLabel>Storage</ProgressLabel>
      <ProgressValue />
    </div>
    <ProgressTrack>
      <ProgressIndicator />
    </ProgressTrack>
  </Progress>
);

export const Indeterminate = (): React.ReactElement => (
  <Progress value={null}>
    <ProgressLabel>Importing</ProgressLabel>
    <ProgressTrack>
      <ProgressIndicator />
    </ProgressTrack>
  </Progress>
);
