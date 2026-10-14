import type { StoryDefault } from "@ladle/react";
import { CheckboxField } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Checkbox field",
  parameters: { subject: ["CheckboxField"] },
} satisfies StoryDefault;

export const Unchecked = (): React.ReactElement => <CheckboxField label="Remember me" />;

export const Checked = (): React.ReactElement => <CheckboxField defaultChecked label="Remember me" />;
