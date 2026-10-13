import type { StoryDefault } from "@ladle/react";
import { CopyValue } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Copy value",
  parameters: { subject: ["CopyValue"] },
} satisfies StoryDefault;

export const RequestId = (): React.ReactElement => (
  <CopyValue copiedLabel="Copied" copyLabel="Copy" label="Request ID" value="0197f3a2-8c1e-7b3d-9e4f-5a6b7c8d9e0f" />
);
