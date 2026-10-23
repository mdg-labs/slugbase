import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { FormField, UrlInput } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/URL input",
  parameters: { subject: ["UrlInput"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState("https://slugbase.app/docs");
  return (
    <FormField label="URL">
      <UrlInput onValueChange={setValue} pendingLabel="Checking the address" placeholder="https://" value={value} />
    </FormField>
  );
};

export const Pending = (): React.ReactElement => (
  <FormField label="URL">
    <UrlInput onValueChange={() => undefined} pending pendingLabel="Checking the address" value="https://slugbase.app/docs" />
  </FormField>
);
