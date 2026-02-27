/**
 * BookmarkCard — scan-first grid layout (Linear/Vercel style).
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
} from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import { Card } from '../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { safeHref } from '../../utils/safeHref';
import { formatRelativeTime, formatFullDateTime } from '../../utils/formatRelativeTime';

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
            <div className="text-xs text-muted-foreground space-y-0.5">
              {bookmark.folders.map((folder) => (
                <div key={folder.id} className="flex items-center gap-1.5">
                  <FolderIcon iconName={folder.icon} size={12} className="text-muted-foreground shrink-0" />
                  {folder.name}
                </div>
              ))}
            </div>
          </div>
        )}
        {hasManyTags && bookmark.tags && (
          <div>
            <div className="font-semibold mb-0.5 text-xs">{t('bookmarks.tags')}</div>
            <div className="text-xs text-muted-foreground flex flex-wrap gap-1">
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

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={`group relative flex flex-col h-[148px] cursor-pointer rounded-lg border bg-card/95 dark:bg-card/90 transition-[border-color,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 px-3 pt-0 pb-1.5 ${
        selected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-border/80 hover:border-primary/80 hover:shadow-[0_2px_6px_rgba(0,0,0,0.06)] dark:border-border/70 dark:hover:border-primary/80 dark:hover:shadow-[0_2px_6px_rgba(0,0,0,0.25)]'
      }`}
    >
      {/* Bulk checkbox: top-right corner when bulk mode active */}
      {bulkMode && (
        <div className="absolute top-3 right-3 z-10" data-card-action>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="text-primary rounded p-0.5 hover:bg-muted/50 transition-colors"
            aria-label={selected ? t('bookmarks.deselect') : t('bookmarks.select')}
          >
            {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          </button>
        </div>
      )}

      {/* Header: icon + title; reserve right space for bulk checkbox so title never overlaps */}
      <header className={`flex-shrink-0 flex items-center gap-1.5 min-w-0 pt-3 ${bulkMode ? 'pr-8' : ''}`}>
        <div
          className={`flex-shrink-0 ${compact ? 'w-6 h-6' : 'w-7 h-7'} rounded-md bg-background/90 dark:bg-muted/20 flex items-center justify-center border border-border/50 overflow-hidden`}
        >
          <Favicon url={bookmark.url} size={compact ? 12 : 14} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <Tooltip content={bookmark.title}>
            <h3 className="text-sm font-semibold text-foreground line-clamp-2 break-words leading-snug tracking-tight min-h-0">
              {bookmark.title}
            </h3>
          </Tooltip>
        </div>
      </header>

      {/* Metadata row: folder (emphasized) · tags (muted) · slug (mono, most-muted); ~8px below title */}
      <div className="flex-shrink-0 min-h-0 min-w-0 text-[10px] truncate mt-2">
        {metaTooltipContent ? (
          <Tooltip content={metaTooltipContent}>
            <p className="truncate cursor-default" title={metadataLine}>
              <span className="font-medium text-foreground/85">{folderLabel}</span>
              {tagNames.length > 0 && (
                <>
                  <span className="text-muted-foreground/50 mx-0.5">·</span>
                  <span className="text-muted-foreground/80">{tagNames.join(SEP)}</span>
                </>
              )}
              {tagOverflow && (
                <>
                  <span className="text-muted-foreground/50 mx-0.5">·</span>
                  <span className="text-muted-foreground/70">+{tagOverflowN}</span>
                </>
              )}
              {slugPart && (
                <>
                  <span className="text-muted-foreground/50 mx-0.5">·</span>
                  <span className="font-mono text-muted-foreground/45">{slugPart}</span>
                </>
              )}
            </p>
          </Tooltip>
        ) : (
          <p className="truncate" title={metadataLine}>
            <span className="font-medium text-foreground/85">{folderLabel}</span>
            {tagNames.length > 0 && (
              <>
                <span className="text-muted-foreground/50 mx-0.5">·</span>
                <span className="text-muted-foreground/80">{tagNames.join(SEP)}</span>
              </>
            )}
            {tagOverflow && (
              <>
                <span className="text-muted-foreground/50 mx-0.5">·</span>
                <span className="text-muted-foreground/70">+{tagOverflowN}</span>
              </>
            )}
            {slugPart && (
              <>
                <span className="text-muted-foreground/50 mx-0.5">·</span>
                <span className="font-mono text-muted-foreground/45">{slugPart}</span>
              </>
            )}
          </p>
        )}
      </div>

      {/* Shared chip: below meta line when bookmark is shared */}
      {isShared && (
        <div className="flex-shrink-0 mt-1">
          <Tooltip
            content={
              <div className="space-y-1">
                <div className="font-semibold mb-1">{t('bookmarks.sharedWith')}</div>
                {bookmark.shared_teams?.map((team) => (
                  <div key={team.id} className="text-xs">• {team.name}</div>
                ))}
                {bookmark.shared_users?.map((user) => (
                  <div key={user.id} className="text-xs">• {user.name || user.email}</div>
                ))}
                {bookmark.folders?.map((folder) => {
                  const hasShares =
                    (folder.shared_teams?.length || 0) > 0 || (folder.shared_users?.length || 0) > 0;
                  if (!hasShares) return null;
                  return (
                    <div key={folder.id} className="text-xs mt-1 pt-1 border-t border-border">
                      <div className="font-semibold mb-0.5">{folder.name}:</div>
                      {folder.shared_teams?.map((team) => (
                        <div key={team.id} className="text-xs pl-2">• {team.name}</div>
                      ))}
                      {folder.shared_users?.map((user) => (
                        <div key={user.id} className="text-xs pl-2">• {user.name || user.email}</div>
                      ))}
                    </div>
                  );
                })}
              </div>
            }
          >
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/10 dark:bg-emerald-500/10 text-muted-foreground rounded cursor-help">
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

      {/* Spacer: pushes footer to bottom without stretching header */}
      <div className="flex-1 min-h-0" aria-hidden />

      {/* Footer: Clicks · Last opened (left); open + kebab (right, hover-only); ~10px above */}
      <footer className="flex-shrink-0 flex items-center justify-between gap-2 h-6 min-h-[24px] pt-2.5">
        <div className="text-[10px] text-foreground/70 truncate min-w-0">
          {t('bookmarks.clicks')}: {typeof bookmark.access_count === 'number' ? bookmark.access_count : '–'}
          {SEP}
          {bookmark.last_accessed_at ? (
            <Tooltip content={formatFullDateTime(bookmark.last_accessed_at)}>
              <span className="cursor-help">
                {t('bookmarks.lastOpened')}: {formatRelativeTime(bookmark.last_accessed_at)}
              </span>
            </Tooltip>
          ) : (
            <span>{t('bookmarks.lastOpened')}: {t('bookmarks.never')}</span>
          )}
        </div>
        <div
          className="flex items-center gap-0.5 flex-shrink-0 w-[52px] justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150"
          data-card-action
        >
          <Tooltip content={t('bookmarks.open')}>
            {onOpen ? (
              <Button
                variant="ghost"
                size="sm"
                icon={ExternalLink}
                iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground transition-colors min-w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                aria-label={t('bookmarks.open')}
              />
            ) : (
              <a
                href={safeHref(bookmark.url)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center justify-center"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ExternalLink}
                  iconClassName="h-3 w-3 stroke-[1.5]"
                  className="h-6 w-6 p-0 min-w-6"
                  aria-label={t('bookmarks.open')}
                />
              </a>
            )}
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                icon={MoreVertical}
                iconClassName="h-3 w-3 stroke-[1.5]"
                className="h-6 w-6 p-0 min-w-6 text-muted-foreground hover:text-foreground transition-colors"
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
      </footer>
    </Card>
  );
}
