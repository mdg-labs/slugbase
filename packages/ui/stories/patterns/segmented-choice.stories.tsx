import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { SegmentedChoice } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Segmented choice",
  parameters: { subject: ["SegmentedChoice"] },
} satisfies StoryDefault;

const THEMES = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState("system");
  return <SegmentedChoice description="System follows your device." label="Theme" name="theme" onValueChange={setValue} options={THEMES} value={value} />;
};

export const WithError = (): React.ReactElement => (
  <SegmentedChoice error="Choose a theme." label="Theme" onValueChange={() => undefined} options={THEMES} value="dark" />
);

export const Disabled = (): React.ReactElement => <SegmentedChoice disabled label="Theme" onValueChange={() => undefined} options={THEMES} value="light" />;
