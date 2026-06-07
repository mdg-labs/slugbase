import type { ReactNode } from "react";

export type ListPageShellProps = {
  /** Default scrollable content; split uses ListPageSplit for master–detail */
  variant?: "default" | "split";
  /** Optional slot above toolbar (e.g. entitlement cap banner) */
  banner?: ReactNode;
  children: ReactNode;
};

/**
 * Prototype-aligned list page layout: optional banner → toolbar → scrollable content.
 * Bleeds to AppShell main edges so the toolbar hairline spans full width.
 */
export function ListPageShell({
  variant = "default",
  banner,
  children,
}: ListPageShellProps) {
  return (
    <div
      className="-mx-sp-7 -mt-sp-7 flex min-h-0 flex-1 flex-col"
      data-list-page-shell={variant}
    >
      {banner}
      {children}
    </div>
  );
}
