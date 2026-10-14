import type { StoryDefault } from "@ladle/react";
import { SettingsNav, type SettingsNavGroup } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Settings nav",
  parameters: { subject: ["SettingsNav"] },
} satisfies StoryDefault;

const GROUPS: readonly SettingsNavGroup[] = [
  {
    id: "account",
    label: "Account",
    items: [
      { id: "profile", label: "Profile", link: <a href="#profile" />, current: true },
      { id: "security", label: "Security", link: <a href="#security" /> },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [{ id: "general", label: "General", link: <a href="#general" /> }],
  },
];

export const Default = (): React.ReactElement => <SettingsNav groups={GROUPS} label="Settings" onNavigate={() => undefined} />;
