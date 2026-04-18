/**
 * BookmarkCard - scan-first grid layout (Linear/Vercel style).
 *
 * Density improvements:
 * - Fixed height ~148px (high-density) and tight padding fit more rows per viewport.
 * - Single metadata row (folder · tags · slug) reduces vertical scan and badge clutter.
 * - Title up to 2 lines (line-clamp-2) with tooltip for full text; favicon in subtle container.
 * - Footer actions on hover (opacity only) keep a calm default and avoid layout shift.
 * - No dividers or heavy badges; cards are visually lighter and easier to scan.
 */
import {
  Share2,
  ExternalLink,
  Copy,
  Edit,
  Trash2,
  CheckSquare,
  Square,
  Pin,
  MoreVertical,
  Link2,
  Eye,
  Star,
} from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { safeHref } from '../../utils/safeHref';

const SEP = ' · ';

interface Bookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  folders?: Array<{ id: string; name: string; icon?: string | null; shared_teams?: Array<{ id: string; name: string }>; shared_users?: Array<{ id: string; name: string; email: string }> }>;
  tags?: Array<{ id: string; name: string }>;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  bookmark_type?: 'own' | 'shared';
  pinned?: boolean;
  access_count?: number;
  last_accessed_at?: string | null;
}

interface BookmarkCardProps {
  bookmark: Bookmark;
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyUrl: () => void;
  onShare?: () => void;
  onOpen?: () => void;
  onPinToggle?: () => void;
  bulkMode: boolean;
  t: any;
}

export default function BookmarkCard({
  bookmark,
  compact,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onCopyUrl,
  onShare,
  onOpen,
  onPinToggle,
  bulkMode,
  t,
}: BookmarkCardProps) {
  const totalSharedTeams =
    (bookmark.shared_teams?.length || 0) +
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
  const totalSharedUsers =
    (bookmark.shared_users?.length || 0) +
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_users?.length || 0), 0) || 0);
  const isShared = totalSharedTeams > 0 || totalSharedUsers > 0;

  const folderLabel =
    bookmark.folders && bookmark.folders.length > 0
      ? bookmark.folders[0].name
      : (t('bookmarks.noFolder') as string);
  const tagNames = bookmark.tags?.slice(0, 3).map((tag) => tag.name) ?? [];
  const tagOverflow = (bookmark.tags?.length ?? 0) > 3;
  const tagOverflowN = (bookmark.tags?.length ?? 0) - 3;
  const slugPart = bookmark.forwarding_enabled ? `/${bookmark.slug}` : '';
  const metaParts: string[] = [folderLabel, ...tagNames];
  if (tagOverflow) metaParts.push(`+${tagOverflowN}`);
  if (slugPart) metaParts.push(slugPart);
  const metadataLine = metaParts.join(SEP);

  const hasMultipleFolders = (bookmark.folders?.length ?? 0) > 1;
  const hasManyTags = (bookmark.tags?.length ?? 0) > 3;
  const metaTooltipContent =
    hasMultipleFolders || hasManyTags ? (
      <div className="space-y-1.5 text-left">
        {hasMultipleFolders && bookmark.folders && (
          <div>
            <div className="font-semibold mb-0.5 text-xs">{t('bookmarks.folders')}</div>
            <div className="space-y-0.5 text-xs text-[var(--fg-2)]">
              {bookmark.folders.map((folder) => (
                <div key={folder.id} className="flex items-center gap-1.5">
                  <FolderIcon iconName={folder.icon} size={12} className="shrink-0 text-[var(--fg-3)]" />
                  {folder.name}
                </div>
              ))}
            </div>
          </div>
        )}
        {hasManyTags && bookmark.tags && (
          <div>
            <div className="font-semibold mb-0.5 text-xs">{t('bookmarks.tags')}</div>
            <div className="flex flex-wrap gap-1 text-xs text-[var(--fg-2)]">
              {bookmark.tags.map((tag) => (
                <span key={tag.id}>{tag.name}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    ) : null;

  function handleCardClick(e: React.MouseEvent) {
    if (bulkMode) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('a') || target.closest('[data-card-action]')) return;
    if (onOpen) onOpen();
    else window.open(bookmark.url, '_blank', 'noopener,noreferrer');
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (bulkMode) return;
      if (onOpen) onOpen();
      else window.open(bookmark.url, '_blank', 'noopener,noreferrer');
    }
  }

  const urlDisplay = (() => {
    try {
      return bookmark.url.replace(/^https?:\/\//, '');
    } catch {
      return bookmark.url;
    }
  })();

  const firstFolder = bookmark.folders?.[0];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={cn(
        'group relative flex min-h-[168px] cursor-pointer flex-col gap-2.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] p-3 transition-[border-color,background,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)]',
        selected ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]' : 'hover:border-[var(--border-strong)] hover:bg-[var(--bg-2)]'
      )}
    >
      {bulkMode && (
        <div className="absolute right-2 top-2 z-10" data-card-action>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="rounded p-0.5 text-[var(--accent)] transition-colors hover:bg-[var(--bg-3)]"
            aria-label={selected ? t('bookmarks.deselect') : t('bookmarks.select')}
          >
            {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          </button>
        </div>
      )}

      <div className={cn('bm-head flex items-start gap-2.5', bulkMode && 'pr-7')}>
        <div
          className={cn(
            'bm-ico flex shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-[var(--bg-3)]',
            compact ? 'h-7 w-7' : 'h-8 w-8'
          )}
        >
          <Favicon url={bookmark.url} size={compact ? 12 : 14} />
        </div>
        <div className="bm-title-wrap min-w-0 flex-1">
          <Tooltip content={bookmark.title}>
            <h3 className="bm-title line-clamp-2 text-[13px] font-medium leading-snug tracking-[-0.005em] text-[var(--fg-0)]">
              {bookmark.title}
            </h3>
          </Tooltip>
          <p className="bm-url mt-0.5 truncate font-mono text-[10.5px] text-[var(--fg-3)]">{urlDisplay}</p>
        </div>
        <div className="bm-menu opacity-0 transition-opacity group-hover:opacity-100" data-card-action>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                icon={MoreVertical}
                iconClassName="h-3.5 w-3.5 stroke-[1.75]"
                className="h-7 w-7 p-0 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
                aria-label={t('bookmarks.moreActions')}
                onClick={(e) => e.stopPropagation()}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {bookmark.bookmark_type === 'own' && onPinToggle && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onPinToggle();
                  }}
                >
                  <Pin className="h-4 w-4" />
                  {bookmark.pinned ? t('bookmarks.pinned') : t('bookmarks.pin')}
                </DropdownMenuItem>
              )}
              {onShare && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onShare();
                  }}
                >
                  <Share2 className="h-4 w-4" />
                  {t('sharing.shareBookmark')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onCopyUrl();
                }}
              >
                <Copy className="h-4 w-4" />
                {t('bookmarks.copyUrl')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                <Edit className="h-4 w-4" />
                {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {metaTooltipContent ? (
        <Tooltip content={metaTooltipContent}>
          <p className="line-clamp-2 min-h-0 cursor-default text-[11.5px] leading-snug text-[var(--fg-2)]" title={metadataLine}>
            {metadataLine}
          </p>
        </Tooltip>
      ) : (
        <p className="line-clamp-2 text-[11.5px] leading-snug text-[var(--fg-2)]" title={metadataLine}>
          {folderLabel}
          {tagNames.length > 0 ? ` · ${tagNames.join(', ')}` : ''}
        </p>
      )}

      <div className="bm-meta flex flex-wrap items-center gap-1.5">
        {bookmark.forwarding_enabled && bookmark.slug ? (
          <span className="bm-slug inline-flex items-center gap-1 font-mono text-[10.5px]">
            <Link2 className="h-2.5 w-2.5 shrink-0 opacity-80" aria-hidden />
            /go/{bookmark.slug}
          </span>
        ) : null}
        {bookmark.tags?.slice(0, 2).map((tag) => (
          <span key={tag.id} className="tag inline-flex items-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--fg-1)]">
            <span className="dot h-1 w-1 rounded-full bg-[var(--accent)]" aria-hidden />
            {tag.name}
          </span>
        ))}
        {(bookmark.tags?.length ?? 0) > 2 && (
          <span className="font-mono text-[10px] text-[var(--fg-3)]">+{(bookmark.tags?.length ?? 0) - 2}</span>
        )}
      </div>

      {isShared && (
        <div className="flex-shrink-0">
          <Tooltip
            content={
              <div className="space-y-1">
                <div className="mb-1 font-semibold">{t('bookmarks.sharedWith')}</div>
                {bookmark.shared_teams?.map((team) => (
                  <div key={team.id} className="text-xs">
                    • {team.name}
                  </div>
                ))}
                {bookmark.shared_users?.map((user) => (
                  <div key={user.id} className="text-xs">
                    • {user.name || user.email}
                  </div>
                ))}
                {bookmark.folders?.map((folder) => {
                  const hasShares =
                    (folder.shared_teams?.length || 0) > 0 || (folder.shared_users?.length || 0) > 0;
                  if (!hasShares) return null;
                  return (
                    <div key={folder.id} className="mt-1 border-t border-[var(--border)] pt-1 text-xs">
                      <div className="mb-0.5 font-semibold">{folder.name}:</div>
                      {folder.shared_teams?.map((team) => (
                        <div key={team.id} className="pl-2 text-xs">
                          • {team.name}
                        </div>
                      ))}
                      {folder.shared_users?.map((user) => (
                        <div key={user.id} className="pl-2 text-xs">
                          • {user.name || user.email}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            }
          >
            <span className="inline-flex cursor-help items-center gap-0.5 rounded-[var(--radius-sm)] bg-[var(--accent-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--fg-2)]">
              <Share2 className="h-2.5 w-2.5" />
              {totalSharedTeams > 0
                ? t('bookmarks.sharedWithTeams', {
                    count: totalSharedTeams,
                    teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams'),
                  })
                : t('bookmarks.shared')}
            </span>
          </Tooltip>
        </div>
      )}

      <footer className="bm-foot mt-auto flex items-center gap-1.5 border-t border-dashed border-[var(--border-soft)] pt-2 font-mono text-[10.5px] text-[var(--fg-3)]">
        {firstFolder ? (
          <span className="folder inline-flex max-w-[45%] items-center gap-1 truncate text-[var(--fg-2)]">
            <FolderIcon iconName={firstFolder.icon} size={10} className="shrink-0 text-[var(--fg-3)]" />
            <span className="truncate">{firstFolder.name}</span>
          </span>
        ) : (
          <span className="text-[var(--fg-3)]">{folderLabel}</span>
        )}
        {bookmark.pinned ? <Star className="h-3 w-3 shrink-0 fill-[var(--warn)] text-[var(--warn)]" aria-hidden /> : null}
        <span className="hits ml-auto inline-flex items-center gap-0.5">
          <Eye className="h-2.5 w-2.5 opacity-80" aria-hidden />
          {typeof bookmark.access_count === 'number' ? bookmark.access_count : '–'}
        </span>
        <Tooltip content={t('bookmarks.open')}>
          {onOpen ? (
            <Button
              variant="ghost"
              size="sm"
              icon={ExternalLink}
              iconClassName="h-3.5 w-3.5 stroke-[1.75]"
              className="ml-1 h-6 w-6 shrink-0 p-0 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              aria-label={t('bookmarks.open')}
            />
          ) : (
            <a href={safeHref(bookmark.url)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="sm"
                icon={ExternalLink}
                iconClassName="h-3 w-3 stroke-[1.75]"
                className="h-6 w-6 p-0"
                aria-label={t('bookmarks.open')}
              />
            </a>
          )}
        </Tooltip>
      </footer>
    </div>
  );
}
