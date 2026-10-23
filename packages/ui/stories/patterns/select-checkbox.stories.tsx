import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { SelectCheckbox } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Select checkbox",
  parameters: { subject: ["SelectCheckbox"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [checked, setChecked] = useState(false);
  return <SelectCheckbox checked={checked} label="Select Example" onCheckedChange={setChecked} />;
};
