import type { ReactNode } from "react";

export type SettingsPageShellProps = {
  children: ReactNode;
  testId?: string;
};

/**
 * Full-width settings page content area — prototype-aligned padding consistent
 * with list page toolbars (px-sp-7 / py-sp-6).
 */
export function SettingsPageShell({ children, testId }: SettingsPageShellProps) {
  return (
    <div className="px-sp-7 py-sp-6" data-testid={testId}>
      {children}
    </div>
  );
}
