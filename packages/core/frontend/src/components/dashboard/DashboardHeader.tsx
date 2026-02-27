import { PageHeader } from '../PageHeader';

export interface DashboardHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Dashboard page header: title, optional subtitle, optional actions.
 * Uses the shared PageHeader for consistency.
 */
export function DashboardHeader({ title, subtitle, actions, className }: DashboardHeaderProps) {
  return <PageHeader title={title} subtitle={subtitle} actions={actions} className={className} />;
}
