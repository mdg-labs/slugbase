import type { ReactNode } from "react";

export type AppShellProps = {
  /** 248px left sidebar content */
  sidebar: ReactNode;
  /** 52px fixed-height top bar content */
  topBar: ReactNode;
  /** Scrollable main content area */
  children: ReactNode;
};

/**
 * Base signed-in layout shell.
 * Grid: 248px sidebar | flexible main column with 52px topbar + scrollable content.
 * Layout is viewport-locked (h-screen, overflow-hidden) - scroll lives inside the
 * main content area only (spec §9.3.1).
 */
export function AppShell({ sidebar, topBar, children }: AppShellProps) {
  return (
    <div
      className="grid h-screen overflow-hidden bg-canvas font-sans text-body text-fg"
      style={{ gridTemplateColumns: "248px 1fr" }}
      data-testid="app-shell"
    >
      <aside
        className="flex min-h-0 flex-col overflow-y-auto border-r border-[color:var(--border-subtle)] bg-base"
        data-testid="app-shell-sidebar"
      >
        {sidebar}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <header
          className="flex shrink-0 items-center border-b border-[color:var(--border-subtle)]"
          style={{ height: 52, background: "color-mix(in srgb, var(--base) 60%, transparent)" }}
          data-testid="app-shell-topbar"
        >
          {topBar}
        </header>
        <main
          className="flex-1 overflow-y-auto bg-canvas p-sp-7"
          data-testid="app-shell-main"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
