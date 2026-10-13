import type { ReactElement, ReactNode } from "react";

/**
 * Marks slugs and URLs so browser translation leaves them as written
 * (doc 03 section 15).
 */
export function NoTranslate({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return (
    <span translate="no" className={className}>
      {children}
    </span>
  );
}
