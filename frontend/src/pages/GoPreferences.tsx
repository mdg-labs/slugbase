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
      <div className="flex items-center gap-4">
        <Link to={`${prefix}/profile`}>
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {t('common.back')}
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t('goPreferences.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('goPreferences.description')}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-ghost bg-surface">
        {preferences.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            {t('goPreferences.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-ghost">
            {preferences.map((pref) => (
              <li
                key={pref.slug}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-high"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono text-primary">
                      /go/{pref.slug}
                    </code>
                    <span className="text-xs px-2 py-0.5 rounded-md border border-ghost bg-surface-low text-muted-foreground">
                      {pref.workspace}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground truncate">
                    {pref.title}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={safeHref(pref.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 text-muted-foreground hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
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
                    className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
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
