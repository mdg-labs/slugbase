import type { ReactElement, ReactNode } from "react";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { cn } from "../lib/utils.ts";

export interface LoadingProps {
  /** What assistive technology announces for the wait. */
  label: string;
  /** The skeleton to show; defaults to a heading and three lines. */
  children?: ReactNode;
  className?: string;
}

/** A page-level wait: skeleton shapes in a status region that tells assistive technology the page is loading. */
export function Loading({ label, children, className }: LoadingProps): ReactElement {
  return (
    <div aria-busy="true" aria-label={label} className={cn("flex flex-col gap-3 p-6", className)} role="status">
      {children ?? (
        <>
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </>
      )}
    </div>
  );
}
