import { Link } from 'react-router-dom';
import { ArrowRight, Zap } from 'lucide-react';
import { DashedDashboardCtaCard } from './DashedDashboardCtaCard';
import type { DashboardBookmarkTileData } from './DashboardBookmarkTile';
import { Card } from '../ui/card';
import Favicon from '../Favicon';

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

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/**
 * Quick access — mockup “Recently added” compact list.
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
  void onCopyUrl;
  const prefix = pathPrefix.replace(/\/+/g, '/') || '';
  const displayItems = items.slice(0, maxItems);
  const createBookmarksUrl = `${prefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true';

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 shrink-0 text-[var(--warn)]" strokeWidth={1.75} aria-hidden />
          <div>
            <h2 className="text-[13px] font-semibold text-[var(--fg-0)]">{t('dashboard.quickAccessBookmarksTitle')}</h2>
            {subtitle ? <p className="mt-0.5 text-[11.5px] text-[var(--fg-2)]">{subtitle}</p> : null}
          </div>
        </div>
        <Link
          to={prefix + '/bookmarks'}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 font-mono text-[11px] font-medium text-[var(--fg-2)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]"
        >
          {t('dashboard.viewAll')}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>

      {displayItems.length === 0 ? (
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3">
          <DashedDashboardCtaCard
            to={createBookmarksUrl}
            title={t('dashboard.quickAccessCreateBookmarkTitle')}
            description={t('dashboard.quickAccessCreateBookmarkDescription')}
          />
        </div>
      ) : (
        <Card className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-0 shadow-[var(--shadow-sm)]">
          {displayItems.map((b, i) => (
            <div
              key={b.id}
              className={`flex items-center gap-2.5 px-3 py-2.5 ${i > 0 ? 'border-t border-[var(--border-soft)]' : ''}`}
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-[var(--bg-3)]">
                <Favicon url={b.url} size={12} />
              </div>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onOpen(b.id, b.url)}
                  className="block w-full truncate text-left text-[12.5px] font-medium text-[var(--fg-0)] hover:text-[var(--accent-hi)]"
                >
                  {b.title}
                </button>
                <span className="block truncate font-mono text-[10.5px] text-[var(--fg-3)]">{stripProtocol(b.url)}</span>
              </div>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
