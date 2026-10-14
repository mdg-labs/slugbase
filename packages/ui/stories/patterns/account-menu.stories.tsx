import type { StoryDefault } from "@ladle/react";
import { AccountMenu, LogOutIcon } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Account menu",
  parameters: { subject: ["AccountMenu"] },
} satisfies StoryDefault;

export const Closed = (): React.ReactElement => (
  <AccountMenu
    items={[{ id: "sign-out", label: "Sign out", icon: <LogOutIcon aria-hidden="true" />, onSelect: () => undefined }]}
    label="Account"
  />
);
