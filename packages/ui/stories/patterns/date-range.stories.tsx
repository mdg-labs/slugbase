import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { DateRange, type DateRangeDays } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Date range",
  parameters: { subject: ["DateRange"] },
} satisfies StoryDefault;

const PRESETS = [
  { value: "any", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "custom", label: "Custom range" },
];

function Example({ initialPreset, initialDays, error }: { initialPreset: string; initialDays: DateRangeDays; error?: string }): React.ReactElement {
  const [preset, setPreset] = useState(initialPreset);
  const [days, setDays] = useState(initialDays);
  return (
    <DateRange
      boundsError="Enter a day from year 0001 to 9999."
      customPreset="custom"
      days={days}
      error={error}
      firstLabel="First day"
      label="Date range"
      lastLabel="Last day"
      onDaysChange={setDays}
      onPresetChange={setPreset}
      orderError="The last day is before the first day."
      preset={preset}
      presets={PRESETS}
    />
  );
}

export const Default = (): React.ReactElement => <Example initialDays={{ first: "", last: "" }} initialPreset="any" />;

export const Preset = (): React.ReactElement => <Example initialDays={{ first: "", last: "" }} initialPreset="7d" />;

export const CustomRange = (): React.ReactElement => <Example initialDays={{ first: "2026-10-01", last: "2026-10-15" }} initialPreset="custom" />;

export const Refused = (): React.ReactElement => (
  <Example error="This range could not be used." initialDays={{ first: "2026-10-01", last: "2026-10-15" }} initialPreset="custom" />
);
