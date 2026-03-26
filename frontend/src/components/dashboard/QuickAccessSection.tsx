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
  const slugDisplay = bookmark.slug ? `go/${bookmark.slug}` : '';
  const domain = hostnameFromUrl(bookmark.url);

  return (
    <div className="group flex min-h-[200px] cursor-pointer flex-col rounded-xl border border-transparent bg-surface p-6 transition-all duration-300 hover:border-ghost hover:bg-surface-high active:scale-[0.98]">
      <div className="mb-6 flex items-start justify-between gap-2">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-ghost bg-surface-lowest transition-colors group-hover:border-primary/30">
          <Favicon url={bookmark.url} className="h-7 w-7" />
        </div>
        <span className="rounded bg-surface-highest px-2 py-1 text-[10px] font-black uppercase tracking-wide text-muted-foreground transition-colors group-hover:text-primary">
          {categoryLabel}
        </span>
      </div>
      <h3 className="mb-1 text-lg font-bold leading-snug text-foreground line-clamp-2">{bookmark.title}</h3>
      <p className="mb-4 line-clamp-2 break-all text-xs text-muted-foreground">{bookmark.url}</p>
      <div className="mt-auto flex items-center justify-between border-t border-ghost pt-4">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {t('dashboard.quickAccessMetaSlug')}
          </span>
          {slugDisplay ? (
            <span className="font-mono text-sm text-primary">{slugDisplay}</span>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </div>
        {domain ? (
          <div className="min-w-0 max-w-[45%] text-right">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {t('dashboard.quickAccessMetaDomain')}
            </span>
            <span className="block truncate text-xs text-foreground">{domain}</span>
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ghost/50 pt-3">
        <button
          type="button"
          onClick={() => onOpen(bookmark.id, bookmark.url)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('dashboard.openBookmark')}
        </button>
        <button
          type="button"
          onClick={() => onCopyUrl(bookmark.url)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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
      className="group flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-ghost bg-transparent p-6 text-center transition-all duration-300 hover:border-primary/50 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-ghost bg-surface text-muted-foreground transition-transform group-hover:scale-110">
        <Plus className="h-5 w-5 text-primary" />
      </span>
      <div className="space-y-1">
        <span className="block text-sm font-bold text-muted-foreground">{title}</span>
        <span className="block text-[10px] text-muted-foreground/80">{description}</span>
      </div>
    </button>
  );
}

/**
 * Quick access: Stitch-style section header, 3-col grid of slug cards + create card.
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
    <section className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Zap className="h-5 w-5 shrink-0 text-primary sm:h-6 sm:w-6" aria-hidden />
          <div>
            <h2 className="text-lg font-bold tracking-tight text-foreground">{t('dashboard.quickAccessSlugsTitle')}</h2>
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
          <CreateNewSlugCard
            pathPrefix={prefix}
            title={t('dashboard.createNewSlug')}
            description={t('dashboard.createNewSlugDescription')}
          />
          <div className="flex min-h-[200px] items-center justify-center rounded-xl border border-ghost bg-surface p-6 md:col-span-2 lg:col-span-2">
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
        <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 lg:grid-cols-3">
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
