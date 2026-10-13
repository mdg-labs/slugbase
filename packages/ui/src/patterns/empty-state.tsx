import type { ReactElement, ReactNode } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";

export interface EmptyStateProps {
  /** A decorative icon. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** The next steps, for example buttons. */
  actions?: ReactNode;
  /** The level of the title in the page's outline; the page's own empty state is level 1. */
  headingLevel?: 1 | 2 | 3 | 4;
}

/** What a list or page shows when it has nothing in it: it says so and offers the way on. */
export function EmptyState({ icon, title, description, actions, headingLevel = 2 }: EmptyStateProps): ReactElement {
  return (
    <Empty>
      <EmptyHeader>
        {icon === undefined ? null : <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle aria-level={headingLevel} role="heading">
          {title}
        </EmptyTitle>
        {description === undefined ? null : <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {actions === undefined ? null : <EmptyContent>{actions}</EmptyContent>}
    </Empty>
  );
}
