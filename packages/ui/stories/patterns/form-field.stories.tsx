import type { StoryDefault } from "@ladle/react";
import { Input } from "../../src/index.ts";
import { FormField } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Form field",
  parameters: { subject: ["FormField"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <FormField description="The address you registered with." label="Email">
    <Input type="email" />
  </FormField>
);

export const WithError = (): React.ReactElement => (
  <FormField error="Enter your email address." label="Email">
    <Input type="email" />
  </FormField>
);
