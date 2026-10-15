import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { ShortcutsProvider, useShortcut } from "../src/index.ts";

export default {
  title: "Shortcuts",
  parameters: { subject: ["ShortcutsProvider"] },
} satisfies StoryDefault;

function Counter(): React.ReactElement {
  const [single, setSingle] = useState(0);
  const [modified, setModified] = useState(0);
  useShortcut({ key: "c" }, () => {
    setSingle((count) => count + 1);
  });
  useShortcut({ key: "k", mod: true }, () => {
    setModified((count) => count + 1);
  });
  return <p>{`C pressed ${String(single)} times, Ctrl or Command K pressed ${String(modified)} times`}</p>;
}

export const SingleKeyOn = (): React.ReactElement => (
  <ShortcutsProvider singleKey>
    <Counter />
  </ShortcutsProvider>
);

export const SingleKeyOff = (): React.ReactElement => (
  <ShortcutsProvider singleKey={false}>
    <Counter />
  </ShortcutsProvider>
);
