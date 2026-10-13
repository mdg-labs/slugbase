import type { StoryDefault } from "@ladle/react";
import { InfoIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../src/index.ts";

export default {
  title: "Alert",
  parameters: { subject: ["Alert", "AlertAction", "AlertDescription", "AlertTitle"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Alert>
    <InfoIcon aria-hidden="true" />
    <AlertTitle>Heads up</AlertTitle>
    <AlertDescription>Your workspace has a new member.</AlertDescription>
  </Alert>
);

export const Variants = (): React.ReactElement => (
  <div className="flex flex-col gap-3">
    {(["info", "success", "warning", "error"] as const).map((variant) => (
      <Alert key={variant} variant={variant}>
        <AlertTitle>{variant}</AlertTitle>
        <AlertDescription>A message that explains what happened.</AlertDescription>
      </Alert>
    ))}
  </div>
);

export const WithAction = (): React.ReactElement => (
  <Alert variant="warning">
    <AlertTitle>Email not verified</AlertTitle>
    <AlertDescription>Verify your address to keep sharing.</AlertDescription>
    <AlertAction>
      <a href="/verify">Verify</a>
    </AlertAction>
  </Alert>
);
