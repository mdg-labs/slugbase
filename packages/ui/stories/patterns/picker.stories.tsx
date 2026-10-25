import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Picker } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Picker",
  parameters: { subject: ["Picker"] },
} satisfies StoryDefault;

const OPTIONS = [
  { value: "ada", label: "Ada Lovelace", description: "ada@example.org" },
  { value: "grace", label: "Grace Hopper", description: "grace@example.org" },
  { value: "hedy", label: "Hedy Lamarr", description: "hedy@example.org" },
];

export const Default = (): React.ReactElement => {
  const [value, setValue] = useState<string | undefined>("grace");
  return <Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={setValue} options={OPTIONS} placeholder="Search members" value={value} />;
};

export const NoOptions = (): React.ReactElement => (
  <Picker emptyLabel="There is nobody else in the workspace" label="Recipient" onValueChange={() => undefined} options={[]} value={undefined} />
);

export const WithError = (): React.ReactElement => (
  <Picker emptyLabel="Nobody matches" error="Choose a recipient." label="Recipient" onValueChange={() => undefined} options={OPTIONS} value={undefined} />
);

export const Loading = (): React.ReactElement => (
  <Picker emptyLabel="There is nobody else in the workspace" label="Recipient" loadingLabel="Loading members" onValueChange={() => undefined} options={[]} value={undefined} />
);

export const Unavailable = (): React.ReactElement => (
  <Picker emptyLabel="There is nobody else in the workspace" label="Recipient" onValueChange={() => undefined} options={[]} unavailableLabel="The members could not be loaded" value={undefined} />
);
