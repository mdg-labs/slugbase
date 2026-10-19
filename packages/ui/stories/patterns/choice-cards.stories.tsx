import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { ChoiceCards } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Choice cards",
  parameters: { subject: ["ChoiceCards"] },
} satisfies StoryDefault;

const OPTIONS = [
  { value: "transfer", label: "Transfer the content", description: "The bookmarks and folders go to another member." },
  { value: "delete", label: "Delete the content", description: "They are removed together with the membership." },
];

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState("transfer");
  return <ChoiceCards label="What happens to the content" name="content" onValueChange={setValue} options={OPTIONS} value={value} />;
};

export const WithError = (): React.ReactElement => (
  <ChoiceCards error="Choose what happens to the content." label="What happens to the content" onValueChange={() => undefined} options={OPTIONS} value="transfer" />
);

export const Disabled = (): React.ReactElement => (
  <ChoiceCards disabled label="What happens to the content" onValueChange={() => undefined} options={OPTIONS} value="delete" />
);
