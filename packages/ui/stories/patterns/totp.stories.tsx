import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { FormField, Totp } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Totp",
  parameters: { subject: ["Totp"] },
} satisfies StoryDefault;

const slotLabel = (position: number, length: number): string => `Digit ${String(position)} of ${String(length)}`;

export const Code = (): React.ReactElement => {
  const [value, setValue] = useState("");
  return (
    <FormField label="Authentication code">
      <Totp onValueChange={setValue} slotLabel={slotLabel} value={value} />
    </FormField>
  );
};

export const Invalid = (): React.ReactElement => (
  <FormField error="That code is not valid." label="Authentication code">
    <Totp onValueChange={() => undefined} slotLabel={slotLabel} value="123456" />
  </FormField>
);

export const Disabled = (): React.ReactElement => (
  <FormField label="Authentication code">
    <Totp disabled onValueChange={() => undefined} slotLabel={slotLabel} value="123" />
  </FormField>
);
