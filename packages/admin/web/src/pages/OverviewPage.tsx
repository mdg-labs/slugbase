import { getMetricsHistory, getOverview } from "../api/client.js";
import { GrowthCharts, PlanMixChart } from "../components/GrowthCharts.js";
import { ErrorRetry } from "../components/Feedback.js";
import { PageHeader } from "../components/PageHeader.js";
import { StatCard, StatGrid } from "../components/StatCard.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

function formatRate(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "—";
  }
  return `${String(Math.round((numerator / denominator) * 100))}%`;
}

export function OverviewPage() {
  const overview = useAsyncData(() => getOverview(), []);
  const metrics = useAsyncData(
    () => getMetricsHistory({ page: 1, limit: 30 }),
    [],
  );

  if (overview.error !== null) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Live platform totals and growth trends" />
        <ErrorRetry message={overview.error} onRetry={overview.reload} />
      </>
    );
  }

  const stats = overview.data;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Live platform totals and growth trends"
      />
      {overview.loading || stats === null ? (
        <StatGrid>
          {Array.from({ length: 6 }, (_, index) => (
            <StatCard key={index} label="…" value="—" />
          ))}
        </StatGrid>
      ) : (
        <StatGrid>
          <StatCard label="Accounts" value={stats.totalAccounts} />
          <StatCard label="Workspaces" value={stats.totalWorkspaces} />
          <StatCard
            label="Signups (7d)"
            value={stats.signupsLast7Days}
            hint={`${String(stats.signupsLast30Days)} in 30d`}
          />
          <StatCard label="Active bookmarks" value={stats.activeBookmarks} />
          <StatCard
            label="MFA adoption"
            value={formatRate(stats.mfaAdoption.enrolled, stats.mfaAdoption.total)}
          />
          <StatCard
            label="Email verified"
            value={formatRate(
              stats.emailVerification.verified,
              stats.emailVerification.total,
            )}
          />
        </StatGrid>
      )}

      {metrics.error !== null ? (
        <ErrorRetry message={metrics.error} onRetry={metrics.reload} />
      ) : metrics.loading ? (
        <p style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          Loading growth charts…
        </p>
      ) : (
        <>
          <GrowthCharts items={metrics.data?.items ?? []} />
          <PlanMixChart items={metrics.data?.items ?? []} />
        </>
      )}
    </>
  );
}
