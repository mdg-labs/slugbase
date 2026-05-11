import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowLeft, Trash2, ExternalLink } from 'lucide-react';
import Button from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { safeHref } from '../utils/safeHref';
import { Badge } from '../components/ui/badge';

interface SlugPreference {
  slug: string;
  bookmark_id: string;
  title: string;
  url: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

export default function GoPreferences() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { showToast } = useToast();
  const [preferences, setPreferences] = useState<SlugPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    loadPreferences();
  }, []);

  async function loadPreferences() {
    try {
      const res = await api.get('/go/preferences');
      setPreferences(res.data);
    } catch (err) {
      console.error('Failed to load preferences:', err);
      showToast(t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(slug: string) {
    setDeleting(slug);
    try {
      await api.delete(`/go/preferences/${encodeURIComponent(slug)}`);
      setPreferences((prev) => prev.filter((p) => p.slug !== slug));
      showToast(t('common.success'), 'success');
    } catch (err) {
      console.error('Failed to remove preference:', err);
      showToast(t('common.error'), 'error');
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="page-head flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <Link to={`${prefix}/profile`} className="shrink-0">
            <Button variant="ghost" size="sm" icon={ArrowLeft}>
              {t('common.back')}
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]">
              {t('goPreferences.title')}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--fg-2)]">{t('goPreferences.description')}</p>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] shadow-[var(--shadow-sm)]">
        {preferences.length === 0 ? (
          <div className="px-6 py-12 text-center text-[13px] text-[var(--fg-2)]">{t('goPreferences.empty')}</div>
        ) : (
          <ul className="divide-y divide-[var(--border-soft)]">
            {preferences.map((pref) => (
              <li
                key={pref.slug}
                className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-hover)] sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-2 py-0.5 font-mono text-[12px] text-[var(--accent-hi)]">
                      /go/{pref.slug}
                    </code>
                    <Badge variant="secondary" className="font-mono text-[10px] text-[var(--fg-2)]">
                      {pref.workspace}
                    </Badge>
                  </div>
                  <p className="truncate text-[13px] text-[var(--fg-1)]">{pref.title}</p>
                </div>
                <div className="flex items-center justify-end gap-1 shrink-0">
                  <a
                    href={safeHref(pref.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-2)] hover:bg-[var(--bg-2)] hover:text-[var(--accent-hi)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                    title={t('common.open')}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => handleRemove(pref.slug)}
                    disabled={deleting === pref.slug}
                    className="text-[var(--danger)] hover:bg-[rgba(248,113,113,0.08)] hover:text-[var(--danger)]"
                    title={t('common.remove')}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
