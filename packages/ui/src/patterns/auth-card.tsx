import { useId, type ReactElement, type ReactNode } from "react";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../components/ui/card.tsx";
import { SlugBaseMark } from "./slugbase-mark.tsx";

export interface AuthCardProps {
  /** The product name written beside the mark. */
  productName: string;
  /** The page's heading. */
  title: ReactNode;
  description?: ReactNode;
  /** The form or message of the page. */
  children: ReactNode;
  /** What sits under the card, for example the language switch. */
  footer?: ReactNode;
}

/** The centred card every sign-in page sits in: the mark and product name, the page's heading, its content and a footer. */
export function AuthCard({ productName, title, description, children, footer }: AuthCardProps): ReactElement {
  const headingId = useId();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center justify-center gap-2 text-foreground">
          <SlugBaseMark className="size-7 text-primary" />
          <span className="font-heading text-lg font-semibold">{productName}</span>
        </div>
        <Card render={<section aria-labelledby={headingId} />}>
          <CardHeader>
            <CardTitle render={<h1 id={headingId} />}>{title}</CardTitle>
            {description === undefined ? null : <CardDescription render={<p />}>{description}</CardDescription>}
          </CardHeader>
          <CardPanel>{children}</CardPanel>
        </Card>
        {footer === undefined ? null : <div className="flex justify-center text-sm text-muted-foreground" data-slot="auth-card-footer">{footer}</div>}
      </div>
    </main>
  );
}
