import type { StoryDefault } from "@ladle/react";
import { Button, Input } from "../../src/index.ts";
import { FormField, SettingsSection } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Settings section",
  parameters: { subject: ["SettingsSection"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <SettingsSection description="How you appear to other members." footer={<Button type="submit">Save</Button>} title="Profile">
    <FormField label="Name">
      <Input defaultValue="Ada Lovelace" />
    </FormField>
  </SettingsSection>
);

export const WithoutFooter = (): React.ReactElement => (
  <SettingsSection title="Email">
    <p className="text-sm">ada@example.org</p>
  </SettingsSection>
);
