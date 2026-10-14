import type { StoryDefault } from "@ladle/react";
import { FormField, SecretInput } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Secret input",
  parameters: { subject: ["SecretInput"] },
} satisfies StoryDefault;

export const Password = (): React.ReactElement => (
  <FormField label="Password">
    <SecretInput autoComplete="current-password" hideLabel="Hide password" showLabel="Show password" />
  </FormField>
);
