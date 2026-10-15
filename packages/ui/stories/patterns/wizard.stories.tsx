import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Input } from "../../src/index.ts";
import { FormField, Wizard } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Wizard",
  parameters: { subject: ["Wizard"] },
} satisfies StoryDefault;

const STEP_COUNT = 3;

export const ThreeSteps = (): React.ReactElement => {
  const [step, setStep] = useState(1);
  return (
    <Wizard
      backLabel="Back"
      description="Three short steps."
      nextLabel={step === STEP_COUNT ? "Finish" : "Next"}
      onBack={
        step === 1
          ? undefined
          : () => {
              setStep(step - 1);
            }
      }
      onNext={() => {
        setStep(Math.min(step + 1, STEP_COUNT));
      }}
      step={step}
      stepCount={STEP_COUNT}
      stepDescription="Tell us a little."
      stepLabel={`Step ${String(step)} of ${String(STEP_COUNT)}`}
      stepTitle={`Step ${String(step)}`}
      title="Set up"
    >
      <FormField label="Name">
        <Input />
      </FormField>
    </Wizard>
  );
};

export const Pending = (): React.ReactElement => (
  <Wizard
    backLabel="Back"
    nextLabel="Finish"
    onBack={() => undefined}
    onNext={() => undefined}
    pending
    step={3}
    stepCount={STEP_COUNT}
    stepLabel="Step 3 of 3"
    stepTitle="Last step"
    title="Set up"
  >
    <FormField label="Name">
      <Input defaultValue="Home" />
    </FormField>
  </Wizard>
);
