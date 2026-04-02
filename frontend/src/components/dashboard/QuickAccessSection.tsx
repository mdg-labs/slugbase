import { Link } from 'react-router-dom';
import { ArrowRight, Zap } from 'lucide-react';
import { DashedDashboardCtaCard } from './DashedDashboardCtaCard';
import { DashboardBookmarkTile, type DashboardBookmarkTileData } from './DashboardBookmarkTile';

export type QuickAccessSectionBookmark = DashboardBookmarkTileData;

export interface QuickAccessSectionProps {
  items: QuickAccessSectionBookmark[];
  pathPrefix: string;
  maxItems?: number;
  subtitle?: string;
  t: (key: string) => string;
  onOpen: (id: string, url: string) => void;
  onCopyUrl: (url: string) => void;
}

/**
 * Quick access: section header and grid of slug cards; dashed create CTA only when empty.
 */
export function QuickAccessSection({
  items,
  pathPrefix,
  maxItems = 6,
  subtitle,
  t,
  onOpen,
  onCopyUrl,
}: QuickAccessSectionProps) {
  const prefix = pathPrefix.replace(/\/+/g, '/') || '';
  const displayItems = items.slice(0, maxItems);
  const categoryLabel = t('dashboard.quickAccessCategory');
  const createBookmarksUrl = `${prefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true';

  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Zap className="h-5 w-5 shrink-0 text-primary sm:h-6 sm:w-6" aria-hidden />
          <div>
            <h2 className="text-lg font-bold tracking-tight text-foreground">{t('dashboard.quickAccessBookmarksTitle')}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        <Link
          to={prefix + '/bookmarks'}
          className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-widest text-primary transition-colors hover:text-primary/90"
        >
          {t('dashboard.viewAll')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {displayItems.length === 0 ? (
        <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 lg:grid-cols-3">
          <DashedDashboardCtaCard
            to={createBookmarksUrl}
            title={t('dashboard.quickAccessCreateBookmarkTitle')}
            description={t('dashboard.quickAccessCreateBookmarkDescription')}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 lg:grid-cols-3">
          {displayItems.map((b) => (
            <DashboardBookmarkTile
              key={b.id}
              bookmark={b}
              pathPrefix={prefix}
              categoryLabel={categoryLabel}
              t={t}
              onOpen={onOpen}
              onCopy={() => onCopyUrl(b.url)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
