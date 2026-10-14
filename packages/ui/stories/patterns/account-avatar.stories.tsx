import type { StoryDefault } from "@ladle/react";
import { AccountAvatar } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Account avatar",
  parameters: { subject: ["AccountAvatar"] },
} satisfies StoryDefault;

export const Preview = (): React.ReactElement => <AccountAvatar name="Ada Lovelace" seed="0192f3a0-bbbb-7000-8000-000000000001" size="lg" />;

export const TopBar = (): React.ReactElement => <AccountAvatar name="Grace" seed="0192f3a0-bbbb-7000-8000-000000000002" />;

export const OtherColours = (): React.ReactElement => (
  <div className="flex gap-2">
    {["0192f3a0-bbbb-7000-8000-000000000003", "0192f3a0-bbbb-7000-8000-000000000004", "0192f3a0-bbbb-7000-8000-000000000005"].map((seed) => (
      <AccountAvatar key={seed} name="Alan Mathison Turing" seed={seed} size="lg" />
    ))}
  </div>
);
