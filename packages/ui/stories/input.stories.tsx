import type { StoryDefault } from "@ladle/react";
import { Input } from "../src/index.ts";

export default {
  title: "Input",
  parameters: { subject: ["Input"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => <Input aria-label="Title" placeholder="Title" />;

export const Sizes = (): React.ReactElement => (
  <div className="flex flex-col gap-3">
    {(["sm", "default", "lg"] as const).map((size) => (
      <Input key={size} aria-label={size} placeholder={size} size={size} />
    ))}
  </div>
);

export const Disabled = (): React.ReactElement => <Input aria-label="Title" disabled placeholder="Title" />;
