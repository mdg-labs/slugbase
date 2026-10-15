import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import type { Accent } from "../../src/index.ts";
import { AccentChoice } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Accent choice",
  parameters: { subject: ["AccentChoice"] },
} satisfies StoryDefault;

const NAMES: Record<Accent, string> = {
  periwinkle: "Periwinkle",
  violet: "Violet",
  rose: "Rose",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
};

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState<Accent>("periwinkle");
  return <AccentChoice description="Colours buttons and the focus ring." label="Accent colour" names={NAMES} onValueChange={setValue} value={value} />;
};

export const Disabled = (): React.ReactElement => <AccentChoice disabled label="Accent colour" names={NAMES} onValueChange={() => undefined} value="teal" />;
