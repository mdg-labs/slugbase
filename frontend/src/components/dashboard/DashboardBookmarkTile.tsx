import { Link } from 'react-router-dom';
import { Copy, ExternalLink, MoreVertical, Share2, Trash2, CheckSquare, Square } from 'lucide-react';
import Favicon from '../Favicon';
import Button from '../ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export interface DashboardBookmarkTileData {
  id: string;
  title: string;
  url: string;
  slug: string;
}

export interface DashboardBookmarkTileListActions {
  onShare?: () => void;
  onDelete?: () => void;
  /** i18n: sharing.shareBookmark */
  shareLabel: string;
  /** i18n: common.delete */
  deleteLabel: string;
  /** aria-label for more menu trigger */
  moreAriaLabel: string;
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
  /** Caller decides what is copied (destination URL vs shortcut, etc.) */
  onCopy: () => void;
  bulkMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Bookmarks list: share/delete behind a compact more menu */
  listActions?: DashboardBookmarkTileListActions;
  /** When false, hide edit link (e.g. shared bookmarks on bookmarks page). Default true for dashboard. */
  showEditLink?: boolean;
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
  onCopy,
  bulkMode = false,
  selected = false,
  onToggleSelect,
  listActions,
  showEditLink = true,
}: DashboardBookmarkTileProps) {
  const slugDisplay = bookmark.slug ? `go ${bookmark.slug}` : '';
  const domain = hostnameFromUrl(bookmark.url);

  const shellClass = [
    'group flex min-h-[200px] flex-col rounded-xl border bg-surface p-6 transition-all duration-300 hover:border-ghost hover:bg-surface-high',
    bulkMode ? '' : 'cursor-pointer active:scale-[0.98]',
    selected ? 'border-primary ring-2 ring-primary/20' : 'border-transparent',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass}>
      <div className="mb-6 flex items-start justify-between gap-2">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-ghost bg-surface-lowest transition-colors group-hover:border-primary/30">
          <Favicon url={bookmark.url} size={16} />
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <span className="rounded bg-surface-highest px-2 py-1 text-[10px] font-black uppercase tracking-wide text-muted-foreground transition-colors group-hover:text-primary">
            {categoryLabel}
          </span>
          {bulkMode && onToggleSelect ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect();
              }}
              className="-mr-1 rounded p-1 text-primary transition-colors hover:bg-surface-high"
              aria-label={selected ? t('bookmarks.deselect') : t('bookmarks.select')}
            >
              {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
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
            <span className="text-sm text-muted-foreground">-</span>
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
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
          {t('dashboard.copyUrl')}
        </button>
        <div className={`flex items-center gap-1 ${showEditLink || (listActions && (listActions.onShare || listActions.onDelete)) ? 'ml-auto' : ''}`}>
          {showEditLink ? (
            <Link
              to={`${pathPrefix}/bookmarks?edit=${encodeURIComponent(bookmark.id)}`.replace(/\/+/g, '/') || `/bookmarks?edit=${bookmark.id}`}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {t('dashboard.editBookmark')}
            </Link>
          ) : null}
          {listActions && (listActions.onShare || listActions.onDelete) ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={MoreVertical}
                  iconClassName="h-3.5 w-3.5"
                  className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={listActions.moreAriaLabel}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {listActions.onShare ? (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      listActions.onShare?.();
                    }}
                  >
                    <Share2 className="h-4 w-4" />
                    {listActions.shareLabel}
                  </DropdownMenuItem>
                ) : null}
                {listActions.onDelete ? (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      listActions.onDelete?.();
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    {listActions.deleteLabel}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </div>
  );
}
