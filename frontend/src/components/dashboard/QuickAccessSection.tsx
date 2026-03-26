import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Bookmark, Copy, ExternalLink, Plus, Zap } from 'lucide-react';
import { EmptyState } from '../EmptyState';
import Button from '../ui/Button';
import Favicon from '../Favicon';

export interface QuickAccessSectionBookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
}

export interface QuickAccessSectionProps {
  items: QuickAccessSectionBookmark[];
  pathPrefix: string;
  maxItems?: number;
  subtitle?: string;
  t: (key: string) => string;
  onOpen: (id: string, url: string) => void;
  onCopyUrl: (url: string) => void;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function QuickAccessSlugCard({
  bookmark,
  pathPrefix,
  categoryLabel,
  t,
  onOpen,
  onCopyUrl,
}: {
  bookmark: QuickAccessSectionBookmark;
  pathPrefix: string;
  categoryLabel: string;
  t: (key: string) => string;
  onOpen: (id: string, url: string) => void;
  onCopyUrl: (url: string) => void;
}) {
  const slugPath = bookmark.slug ? `/go/${bookmark.slug}` : '';
  const domain = hostnameFromUrl(bookmark.url);

  return (
    <div
      className="rounded-xl border border-ghost bg-surface p-4 flex flex-col gap-3 text-left transition-colors hover:bg-surface-high min-h-[160px]"
      data-testid="quick-access-card"
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className="shrink-0 rounded-lg border border-ghost bg-surface-low p-2">
          <Favicon url={bookmark.url} className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="typography-label">{categoryLabel}</p>
          <h3 className="text-base font-semibold text-foreground line-clamp-2">{bookmark.title}</h3>
          <p className="text-sm text-muted-foreground line-clamp-2 break-all">{bookmark.url}</p>
        </div>
      </div>
      <div className="mt-auto pt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono text-muted-foreground">
        {slugPath && <span className="text-primary">{slugPath}</span>}
        {domain && <span className="truncate max-w-[140px]">{domain}</span>}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onOpen(bookmark.id, bookmark.url)}
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-primary hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('dashboard.openBookmark')}
        </button>
        <button
          type="button"
          onClick={() => onCopyUrl(bookmark.url)}
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Copy className="h-3.5 w-3.5" />
          {t('dashboard.copyUrl')}
        </button>
        <Link
          to={`${pathPrefix}/bookmarks?edit=${encodeURIComponent(bookmark.id)}`.replace(/\/+/g, '/') || `/bookmarks?edit=${bookmark.id}`}
          className="ml-auto text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {t('dashboard.editBookmark')}
        </Link>
      </div>
    </div>
  );
}

function CreateNewSlugCard({
  pathPrefix,
  title,
  description,
}: {
  pathPrefix: string;
  title: string;
  description: string;
}) {
  const navigate = useNavigate();
  const to = `${pathPrefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true';

  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="rounded-xl border border-dashed border-ghost bg-transparent p-4 flex flex-col items-center justify-center gap-3 text-center min-h-[160px] transition-colors hover:bg-surface-high/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-ghost bg-surface-low text-primary">
        <Plus className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <span className="block text-base font-semibold text-foreground">{title}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </div>
    </button>
  );
}

/**
 * Quick access: section header, 3-col grid of slug cards + create card, Obsidian styling.
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

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary shrink-0" aria-hidden />
          <div>
            <h2 className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
              {t('dashboard.quickAccess')}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        <Link
          to={prefix + '/bookmarks'}
          className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
        >
          {t('dashboard.viewAll')}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {displayItems.length === 0 ? (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 items-stretch">
          <CreateNewSlugCard
            pathPrefix={prefix}
            title={t('dashboard.createNewSlug')}
            description={t('dashboard.createNewSlugDescription')}
          />
          <div className="md:col-span-2 lg:col-span-2 rounded-xl border border-ghost bg-surface p-6 flex items-center justify-center min-h-[160px]">
            <EmptyState
              icon={Bookmark}
              title={t('dashboard.noQuickAccessBookmarks')}
              description={t('dashboard.noQuickAccessBookmarksHint')}
              action={
                <Link to={`${prefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true'}>
                  <Button variant="primary" icon={Plus}>
                    {t('bookmarks.create')}
                  </Button>
                </Link>
              }
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 items-stretch">
          {displayItems.map((b) => (
            <QuickAccessSlugCard
              key={b.id}
              bookmark={b}
              pathPrefix={prefix}
              categoryLabel={categoryLabel}
              t={t}
              onOpen={onOpen}
              onCopyUrl={onCopyUrl}
            />
          ))}
          <CreateNewSlugCard
            pathPrefix={prefix}
            title={t('dashboard.createNewSlug')}
            description={t('dashboard.createNewSlugDescription')}
          />
        </div>
      )}
    </section>
  );
}
