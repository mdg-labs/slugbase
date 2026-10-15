import { useId, type ReactElement, type ReactNode } from "react";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";
import { SlugBaseMark } from "./slugbase-mark.tsx";

export interface AuthLayoutProps {
  /** The product name written beside the mark. */
  productName: string;
  /** The page's card or wizard. */
  children: ReactNode;
  /** What sits under the card, for example the language switch. */
  footer?: ReactNode;
  /** How wide the content may grow: `sm` for a sign-in card, `md` for a wizard. */
  size?: "sm" | "md";
}

/** The page every sign-in screen sits on: the main region, the mark and product name above the content, and a footer under it. */
export function AuthLayout({ productName, children, footer, size = "sm" }: AuthLayoutProps): ReactElement {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-4">
      <div className={cn("flex w-full flex-col gap-6", size === "md" ? "max-w-lg" : "max-w-sm")}>
        <div className="flex items-center justify-center gap-2 text-foreground">
          <SlugBaseMark className="size-7 text-primary" />
          <span className="font-heading text-lg font-semibold">{productName}</span>
        </div>
        {children}
        {footer === undefined ? null : <div className="flex justify-center text-sm text-muted-foreground" data-slot="auth-card-footer">{footer}</div>}
      </div>
    </main>
  );
}

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
    <AuthLayout footer={footer} productName={productName}>
      <Card render={<section aria-labelledby={headingId} />}>
        <CardHeader>
          <CardTitle render={<h1 id={headingId} />}>{title}</CardTitle>
          {description === undefined ? null : <CardDescription render={<p />}>{description}</CardDescription>}
        </CardHeader>
        <CardPanel>{children}</CardPanel>
      </Card>
    </AuthLayout>
  );
}
