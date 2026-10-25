import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { MultiPick } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/MultiPick",
  parameters: { subject: ["MultiPick"] },
} satisfies StoryDefault;

const OPTIONS = [
  { value: "reading", label: "Reading" },
  { value: "work", label: "Work" },
  { value: "recipes", label: "Recipes" },
];

const removeLabel = (label: string): string => `Remove ${label}`;

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState<string[]>(["work"]);
  return <MultiPick emptyLabel="There are no folders yet" label="Folders" onValueChange={setValue} options={OPTIONS} placeholder="Search folders" removeLabel={removeLabel} value={value} />;
};

export const Creatable = (): React.ReactElement => {
  const [options, setOptions] = useState(OPTIONS);
  const [value, setValue] = useState<string[]>([]);
  return (
    <MultiPick
      creatable={{
        label: (name) => `Create folder “${name}”`,
        onCreate: (name) => {
          setOptions((current) => [...current, { value: name, label: name }]);
          setValue((current) => [...current, name]);
        },
      }}
      emptyLabel="There are no folders yet"
      label="Folders"
      onValueChange={setValue}
      options={options}
      placeholder="Search or create a folder"
      removeLabel={removeLabel}
      value={value}
    />
  );
};

export const Loading = (): React.ReactElement => (
  <MultiPick emptyLabel="There are no folders yet" label="Folders" loadingLabel="Loading folders" onValueChange={() => undefined} options={[]} removeLabel={removeLabel} value={[]} />
);

export const Unavailable = (): React.ReactElement => (
  <MultiPick
    emptyLabel="There are no folders yet"
    label="Folders"
    onValueChange={() => undefined}
    options={[]}
    removeLabel={removeLabel}
    unavailableLabel="The folders could not be loaded"
    value={[]}
  />
);

export const WithError = (): React.ReactElement => (
  <MultiPick emptyLabel="There are no tags yet" error="Use at most 40 characters." label="Tags" onValueChange={() => undefined} options={[]} removeLabel={removeLabel} value={[]} />
);
