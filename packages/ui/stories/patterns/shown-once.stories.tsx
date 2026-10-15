import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { ShownOnce } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Shown once",
  parameters: { subject: ["ShownOnce"] },
} satisfies StoryDefault;

function Story({ values }: { values: readonly string[] }): React.ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <ShownOnce
      acknowledgeLabel="I have saved these codes"
      acknowledged={acknowledged}
      copiedLabel="Copied"
      copyLabel="Copy all codes"
      label="Backup codes"
      note="Keep them somewhere safe. They are not shown again."
      onAcknowledgedChange={setAcknowledged}
      values={values}
    />
  );
}

export const BackupCodes = (): React.ReactElement => (
  <Story
    values={["ABCDEFGH23", "JKLMNPQR45", "STUVWXYZ67", "BCDFGHJK89", "MNPQRSTU23", "VWXYZABC45", "DEFGHJKL67", "NPQRSTUV89", "WXYZABCD23", "EFGHJKLM45"]}
  />
);

export const SingleValue = (): React.ReactElement => <Story values={["a-secret-shown-a-single-time"]} />;
