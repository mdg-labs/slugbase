import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert.tsx";

export type BannerVariant = "error" | "info" | "success" | "warning";

const ICONS: Record<BannerVariant, typeof InfoIcon> = {
  error: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
};

export interface BannerProps {
  /** The severity; it sets the colour, the icon and how urgently assistive technology announces the banner. */
  variant?: BannerVariant;
  title: ReactNode;
  description?: ReactNode;
  /** The way to act on the condition, for example a button or a link. */
  action?: ReactNode;
  className?: string;
}

/** A condition that stays on the page until it clears, with the action that clears it. Only an error is announced as an alert. */
export function Banner({ variant = "info", title, description, action, className }: BannerProps): ReactElement {
  const Icon = ICONS[variant];
  return (
    <Alert className={className} role={variant === "error" ? "alert" : "status"} variant={variant}>
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {description === undefined ? null : <AlertDescription>{description}</AlertDescription>}
      {action === undefined ? null : <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}
