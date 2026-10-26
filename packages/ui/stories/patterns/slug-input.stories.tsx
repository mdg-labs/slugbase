import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { FormField, SlugInput } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Slug input",
  parameters: { subject: ["SlugInput"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState("docs");
  return (
    <FormField label="Slug">
      <SlugInput onValueChange={setValue} pendingLabel="Checking the slug" placeholder="mail" value={value} />
    </FormField>
  );
};

export const Pending = (): React.ReactElement => (
  <FormField label="Slug">
    <SlugInput onValueChange={() => undefined} pending pendingLabel="Checking the slug" value="docs" />
  </FormField>
);

export const Invalid = (): React.ReactElement => (
  <FormField error="Use 1 to 64 lowercase letters, digits and hyphens, and do not start with a hyphen." label="Slug">
    <SlugInput onValueChange={() => undefined} pendingLabel="Checking the slug" value="-docs" />
  </FormField>
);
