import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { SelectField } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Select field",
  parameters: { subject: ["SelectField"] },
} satisfies StoryDefault;

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
];

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState("en");
  return <SelectField description="The language of the app and of your emails." label="Language" name="locale" onValueChange={setValue} options={LANGUAGES} value={value} />;
};

export const WithError = (): React.ReactElement => (
  <SelectField error="Choose a language." label="Language" onValueChange={() => undefined} options={LANGUAGES} value="en" />
);

export const Disabled = (): React.ReactElement => <SelectField disabled label="Language" onValueChange={() => undefined} options={LANGUAGES} value="de" />;

export const HiddenLabel = (): React.ReactElement => {
  const [value, setValue] = useState("en");
  return <SelectField hideLabel label="Language of Ada" onValueChange={setValue} options={LANGUAGES} value={value} />;
};
