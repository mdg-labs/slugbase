import type { StoryDefault } from "@ladle/react";
import { Checkbox } from "../src/index.ts";

export default {
  title: "Checkbox",
  parameters: { subject: ["Checkbox"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <Checkbox aria-label="Select Example" />;

export const Checked = (): React.ReactElement => <Checkbox aria-label="Select Example" defaultChecked />;

export const Indeterminate = (): React.ReactElement => <Checkbox aria-label="Select all Examples" indeterminate />;

export const Disabled = (): React.ReactElement => <Checkbox aria-label="Select Example" disabled />;
