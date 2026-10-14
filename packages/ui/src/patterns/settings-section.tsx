import type { ReactElement, ReactNode } from "react";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "../components/ui/card.tsx";

export interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** The fields of the section. */
  children: ReactNode;
  /** The section's own actions, for example its Save button. */
  footer?: ReactNode;
  className?: string;
}

/** One titled card of a settings page (doc 03 section 11): a heading, the section's fields, and its own actions. */
export function SettingsSection({ title, description, children, footer, className }: SettingsSectionProps): ReactElement {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle render={<h2 />}>{title}</CardTitle>
        {description === undefined ? null : <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardPanel>{children}</CardPanel>
      {footer === undefined ? null : <CardFooter className="justify-end gap-2">{footer}</CardFooter>}
    </Card>
  );
}
