import type { ReactNode } from "react";

export type AppShellProps = {
  brandLabel: string;
  workspaceLabel: string;
  headerActions?: ReactNode;
  children: ReactNode;
};

/** Base signed-in layout shell (sidebar + main). */
export function AppShell({
  brandLabel,
  workspaceLabel,
  headerActions,
  children,
}: AppShellProps) {
  return (
    <div
      className="flex min-h-screen bg-canvas font-sans text-body text-fg"
      data-testid="app-shell"
    >
      <aside
        className="flex w-56 shrink-0 flex-col border-r border-[color:var(--border)] bg-base"
        data-testid="app-shell-sidebar"
      >
        <div className="border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
          <p className="t-h3">{brandLabel}</p>
          <p className="t-small mt-sp-4">{workspaceLabel}</p>
        </div>
        <nav className="flex-1 px-sp-4 py-sp-5" aria-label={workspaceLabel} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center justify-end gap-sp-5 border-b border-[color:var(--border-subtle)] bg-base px-sp-6 py-sp-5"
          data-testid="app-shell-header"
        >
          {headerActions}
        </header>
        <main className="flex-1 bg-canvas p-sp-8" data-testid="app-shell-main">
          {children}
        </main>
      </div>
    </div>
  );
}
