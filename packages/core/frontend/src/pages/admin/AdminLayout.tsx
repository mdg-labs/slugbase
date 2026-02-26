import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { getDocsApiReferenceUrl } from '../../config/docs';

export default function AdminLayout() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t('admin.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('admin.description')}</p>
      </div>

      {/* Child route content */}
      <Outlet />

      {/* API Documentation Link */}
      <div className="mt-8 pt-6 border-t border-border">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              {t('admin.apiDocsNote')}
            </p>
          </div>
          <a
            href={getDocsApiReferenceUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary hover:text-primary/90 transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            {t('admin.viewApiDocs')}
          </a>
        </div>
      </div>
    </div>
  );
}
