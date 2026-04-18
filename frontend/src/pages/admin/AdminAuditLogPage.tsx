import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { PageLoadingSkeleton } from '../../components/ui/PageLoadingSkeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { EmptyState } from '../../components/EmptyState';
import { ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';

type AuditEvent = {
  id: string;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
};

function actionBadgeClass(action: string): string {
  const a = action.toLowerCase();
  if (a.includes('delete') || a.includes('remove')) {
    return 'border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.12)] text-[var(--danger)]';
  }
  if (a.includes('create') || a.includes('add') || a.includes('invite')) {
    return 'border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.12)] text-[var(--success)]';
  }
  if (a.includes('update') || a.includes('edit') || a.includes('change')) {
    return 'border-[rgba(96,165,250,0.35)] bg-[rgba(96,165,250,0.15)] text-[var(--info)]';
  }
  return 'border-[var(--border)] bg-[var(--bg-3)] text-[var(--fg-1)]';
}

export default function AdminAuditLogPage() {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<{ before_created_at: string; before_id: string } | null>(null);

  const fetchPage = useCallback(
    async (cursor: { before_created_at: string; before_id: string } | null, append: boolean) => {
      const params: Record<string, string> = { limit: '50' };
      if (cursor) {
        params.before_created_at = cursor.before_created_at;
        params.before_id = cursor.before_id;
      }
      const res = await api.get<{ events: AuditEvent[]; next_cursor: typeof cursor }>('/admin/audit-log', {
        params,
      });
      const rows = res.data.events ?? [];
      if (append) {
        setEvents((prev) => [...prev, ...rows]);
      } else {
        setEvents(rows);
      }
      setNextCursor(res.data.next_cursor ?? null);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(null, false)
      .catch((err) => {
        if (!cancelled) {
          const msg = err.response?.data?.error ?? err.message ?? t('admin.auditLog.loadError');
          setError(typeof msg === 'string' ? msg : t('admin.auditLog.loadError'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, t]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      await fetchPage(nextCursor, true);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e.response?.data?.error ?? e.message ?? t('admin.auditLog.loadError');
      setError(typeof msg === 'string' ? msg : t('admin.auditLog.loadError'));
    } finally {
      setLoadingMore(false);
    }
  };

  function formatMeta(meta: Record<string, unknown>): string {
    try {
      return JSON.stringify(meta);
    } catch {
      return '';
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]">{t('admin.auditLog.title')}</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--fg-2)]">{t('admin.auditLog.description')}</p>
      </div>

      {error && (
        <div className="rounded-[var(--radius-lg)] border border-[rgba(248,113,113,0.4)] bg-[rgba(248,113,113,0.08)] px-4 py-3 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <PageLoadingSkeleton lines={6} />
      ) : events.length === 0 ? (
        <EmptyState icon={ScrollText} title={t('admin.auditLog.title')} description={t('admin.auditLog.empty')} />
      ) : (
        <Card className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-0 shadow-none">
          <Table>
            <TableHeader>
              <TableRow className="border-[var(--border-soft)] bg-[var(--bg-2)] hover:bg-[var(--bg-2)]">
                <TableHead className="font-mono text-[11px] uppercase tracking-wide text-[var(--fg-2)]">
                  {t('admin.auditLog.colTime')}
                </TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wide text-[var(--fg-2)]">
                  {t('admin.auditLog.colActor')}
                </TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wide text-[var(--fg-2)]">
                  {t('admin.auditLog.colAction')}
                </TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wide text-[var(--fg-2)]">
                  {t('admin.auditLog.colEntity')}
                </TableHead>
                <TableHead className="min-w-[160px] font-mono text-[11px] uppercase tracking-wide text-[var(--fg-2)]">
                  {t('admin.auditLog.colDetails')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id} className="align-top border-[var(--border-soft)] hover:bg-[var(--bg-hover)]">
                  <TableCell className="whitespace-nowrap text-[12px] text-[var(--fg-2)]">
                    {e.created_at ? new Date(e.created_at).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <div className="font-medium text-[var(--fg-0)]">{e.actor_name || e.actor_email || '—'}</div>
                    {e.actor_email && e.actor_name ? (
                      <div className="text-[11px] text-[var(--fg-2)]">{e.actor_email}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn('font-mono text-[10px]', actionBadgeClass(e.action))}>
                      {e.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-[12px]">
                    <span className="text-[var(--fg-2)]">{e.entity_type}</span>
                    {e.entity_id ? (
                      <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--fg-1)]">{e.entity_id}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[min(100vw,420px)] break-all font-mono text-[11px] text-[var(--fg-2)]">
                    {formatMeta(e.metadata || {})}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {!loading && nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] px-4 py-2 text-[13px] font-medium text-[var(--fg-0)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          {loadingMore ? t('common.loading') : t('admin.auditLog.loadMore')}
        </button>
      ) : null}
    </div>
  );
}
