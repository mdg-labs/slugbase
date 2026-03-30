import { Link } from 'react-router-dom';
import { Copy, ExternalLink } from 'lucide-react';
import Favicon from '../Favicon';

export interface DashboardBookmarkTileData {
  id: string;
  title: string;
  url: string;
  slug: string;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface DashboardBookmarkTileProps {
  bookmark: DashboardBookmarkTileData;
  pathPrefix: string;
  /** Uppercase badge at top-right (e.g. shortcut label or "Pinned") */
  categoryLabel: string;
  t: (key: string) => string;
  onOpen: (id: string, url: string) => void;
  onCopyUrl: (url: string) => void;
}

/**
 * Dashboard grid tile: matches Quick access / Pinned bookmark card size and style.
 */
export function DashboardBookmarkTile({
  bookmark,
  pathPrefix,
  categoryLabel,
  t,
  onOpen,
  onCopyUrl,
}: DashboardBookmarkTileProps) {
  const slugDisplay = bookmark.slug ? `go ${bookmark.slug}` : '';
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
            {t('dashboard.quickAccessMetaShortcut')}
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
