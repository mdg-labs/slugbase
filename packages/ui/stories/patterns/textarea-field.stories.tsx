import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { TextareaField } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Textarea field",
  parameters: { subject: ["TextareaField"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState("A short note about the page.");
  return <TextareaField counter={`${String(value.length)} / 1,000`} label="Description" maxLength={1000} onChange={setValue} value={value} />;
};

export const WithError = (): React.ReactElement => (
  <TextareaField counter="1,000 / 1,000" error="Use at most 1,000 characters." label="Description" maxLength={1000} onChange={() => undefined} value="" />
);
