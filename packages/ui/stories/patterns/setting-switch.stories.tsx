import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { SettingSwitch } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Setting switch",
  parameters: { subject: ["SettingSwitch"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [checked, setChecked] = useState(true);
  return (
    <SettingSwitch
      checked={checked}
      description="Press a letter to act, for example C to create a bookmark."
      label="Single-key shortcuts"
      onCheckedChange={setChecked}
    />
  );
};

export const Disabled = (): React.ReactElement => <SettingSwitch checked disabled label="Single-key shortcuts" onCheckedChange={() => undefined} />;

export const WithError = (): React.ReactElement => (
  <SettingSwitch checked={false} error="This change was not saved." label="Single-key shortcuts" onCheckedChange={() => undefined} />
);
