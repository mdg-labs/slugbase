import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { getDocsApiReferenceUrl } from '../../config/docs';

export default function AdminLayout() {
  const { t } = useTranslation();

  return (
    <div className="space-y-8 pb-8">
      <Outlet />

      <div className="rounded-xl border border-ghost bg-surface-low px-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{t('admin.apiDocsNote')}</p>
          <a
            href={getDocsApiReferenceUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-xl border border-ghost bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-high"
          >
            <ExternalLink className="h-4 w-4" />
            {t('admin.viewApiDocs')}
          </a>
        </div>
      </div>
    </div>
  );
}
