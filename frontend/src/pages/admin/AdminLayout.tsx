import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { DOCS_API_OPERATIONS, getDocsApiReferenceOperationUrl, getDocsApiReferenceUrl } from '../../config/docs';

export default function AdminLayout() {
  const { t } = useTranslation();

  return (
    <div className="space-y-8 pb-8">
      <Outlet />

      <div className="rounded-xl border border-ghost bg-surface-low px-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2 min-w-0">
            <p className="text-sm text-muted-foreground">{t('admin.apiDocsNote')}</p>
            <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{t('admin.apiDocsShortcuts')}</span>
              <a
                href={getDocsApiReferenceOperationUrl(DOCS_API_OPERATIONS.csrfToken)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:text-primary/90 underline-offset-2 hover:underline"
              >
                {t('admin.apiDocsCsrfEndpoint')}
              </a>
              <span className="text-muted-foreground/70" aria-hidden>
                ·
              </span>
              <a
                href={getDocsApiReferenceOperationUrl(DOCS_API_OPERATIONS.listTokens)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:text-primary/90 underline-offset-2 hover:underline"
              >
                {t('admin.apiDocsTokensEndpoint')}
              </a>
            </p>
          </div>
          <a
            href={getDocsApiReferenceUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit shrink-0 items-center gap-2 rounded-xl border border-ghost bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-high"
          >
            <ExternalLink className="h-4 w-4" />
            {t('admin.viewApiDocs')}
          </a>
        </div>
      </div>
    </div>
  );
}
