import { useId, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardDescription,
  CardFooter,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
  CardHeader,
  CardPanel,
  CardTitle,
} from "../components/ui/card.tsx";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from "../components/ui/progress.tsx";

export interface WizardProps {
  /** The wizard's heading. */
  title: ReactNode;
  description?: ReactNode;
  /** The current step, counted from 1. */
  step: number;
  stepCount: number;
  /** The position in words, for example "Step 2 of 3"; it names the progress bar. */
  stepLabel: string;
  /** The heading of the current step. */
  stepTitle: ReactNode;
  stepDescription?: ReactNode;
  /** The fields and notes of the current step. */
  children: ReactNode;
  /** The name of the Back button. */
  backLabel: string;
  /** The name of the button that goes on: "Next", or the action of the last step. */
  nextLabel: string;
  /** Goes back one step. Without it the Back button is not shown, as on the first step. */
  onBack?: () => void;
  /** Called when the step is submitted, by the Next button or the Enter key; the step checks its fields and goes on. */
  onNext: () => void;
  /** Keeps Next from acting until the step allows it, for example until a shown-once secret is acknowledged. */
  nextDisabled?: boolean;
  /** A request of the step is running: Next shows it and neither button acts. */
  pending?: boolean;
  className?: string;
}

/**
 * Steps in a frame (doc 03 `wizard`): a progress bar that names the position, the current step's heading
 * and fields, and a Back and Next pair. The wizard keeps no state; the page owns the step and its values.
 */
export function Wizard({
  title,
  description,
  step,
  stepCount,
  stepLabel,
  stepTitle,
  stepDescription,
  children,
  backLabel,
  nextLabel,
  onBack,
  onNext,
  nextDisabled = false,
  pending = false,
  className,
}: WizardProps): ReactElement {
  const headingId = useId();
  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!pending && !nextDisabled) {
      onNext();
    }
  }
  return (
    <CardFrame className={className} render={<section aria-labelledby={headingId} />}>
      <CardFrameHeader>
        <CardFrameTitle render={<h1 id={headingId} />}>{title}</CardFrameTitle>
        {description === undefined ? null : <CardFrameDescription render={<p />}>{description}</CardFrameDescription>}
      </CardFrameHeader>
      <Card render={<form noValidate />} onSubmit={submit}>
        <CardHeader>
          <Progress getAriaValueText={() => stepLabel} max={stepCount} min={0} value={step}>
            <ProgressLabel className="text-muted-foreground text-xs">{stepLabel}</ProgressLabel>
            <ProgressTrack>
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
          <CardTitle render={<h2 />}>{stepTitle}</CardTitle>
          {stepDescription === undefined ? null : <CardDescription render={<p />}>{stepDescription}</CardDescription>}
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">{children}</CardPanel>
        <CardFooter className="justify-between gap-2">
          {onBack === undefined ? (
            <span />
          ) : (
            <Button disabled={pending} onClick={onBack} type="button" variant="outline">
              {backLabel}
            </Button>
          )}
          <Button disabled={nextDisabled} loading={pending} type="submit">
            {nextLabel}
          </Button>
        </CardFooter>
      </Card>
    </CardFrame>
  );
}
