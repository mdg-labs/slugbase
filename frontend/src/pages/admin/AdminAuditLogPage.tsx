import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';

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
    } catch (err: any) {
      const msg = err.response?.data?.error ?? err.message ?? t('admin.auditLog.loadError');
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
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('admin.auditLog.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('admin.auditLog.description')}</p>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">{t('common.loading')}</div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-ghost bg-surface-low px-4 py-8 text-center text-sm text-muted-foreground">
          {t('admin.auditLog.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ghost bg-card">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-ghost bg-surface-low/80 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t('admin.auditLog.colTime')}</th>
                <th className="px-4 py-3">{t('admin.auditLog.colActor')}</th>
                <th className="px-4 py-3">{t('admin.auditLog.colAction')}</th>
                <th className="px-4 py-3">{t('admin.auditLog.colEntity')}</th>
                <th className="px-4 py-3">{t('admin.auditLog.colDetails')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ghost">
              {events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {e.created_at ? new Date(e.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{e.actor_name || e.actor_email || '—'}</div>
                    {e.actor_email && e.actor_name ? (
                      <div className="text-xs text-muted-foreground">{e.actor_email}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{e.action}</td>
                  <td className="px-4 py-3 text-xs">
                    <span className="text-muted-foreground">{e.entity_type}</span>
                    {e.entity_id ? <div className="mt-0.5 font-mono text-[11px] break-all">{e.entity_id}</div> : null}
                  </td>
                  <td className="max-w-md px-4 py-3 font-mono text-[11px] text-muted-foreground break-all">
                    {formatMeta(e.metadata || {})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="rounded-xl border border-ghost bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-high disabled:opacity-50"
        >
          {loadingMore ? t('common.loading') : t('admin.auditLog.loadMore')}
        </button>
      ) : null}
    </div>
  );
}
