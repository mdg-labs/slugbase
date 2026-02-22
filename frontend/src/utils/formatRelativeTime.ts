/**
 * Format an ISO date string as relative time (e.g. "2d ago", "5m ago").
 * Returns "Never" or "-" for null/undefined/empty.
 */
export function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString || isoString.trim() === '') return 'Never';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 4) return `${diffWeek}w ago`;
  return date.toLocaleDateString();
}

/**
 * Format an ISO date string for tooltip (full date and time).
 */
export function formatFullDateTime(isoString: string | null | undefined): string {
  if (!isoString || isoString.trim() === '') return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
