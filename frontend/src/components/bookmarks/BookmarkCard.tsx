import {
  Share2,
  Tag as TagIcon,
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
import { Badge } from '../ui/badge';
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

const ROW_HEIGHT = 'h-6';
const CONTENT_ROW = 'min-h-[24px]';

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

  const cardHeight = compact ? 'h-[200px]' : 'h-[240px]';

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={`group flex flex-col ${cardHeight} cursor-pointer rounded-2xl border transition-shadow transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        selected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-border hover:border-primary/70 hover:shadow-md'
      } p-2`}
    >
      {/* A) Header: fixed height */}
      <header className="flex-shrink-0 flex items-center justify-between gap-2 min-h-[52px]">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {bulkMode && (
            <button
              data-card-action
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
              }}
              className="flex-shrink-0 text-primary"
            >
              {selected ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
            </button>
          )}
          <div
            className={`flex-shrink-0 ${compact ? 'w-8 h-8' : 'w-9 h-9'} rounded-lg bg-primary/20 flex items-center justify-center border border-primary/30 overflow-hidden`}
          >
            <Favicon url={bookmark.url} size={compact ? 16 : 18} />
          </div>
          <h3 className="flex-1 min-w-0 text-sm font-semibold text-foreground truncate line-clamp-1 leading-snug overflow-hidden">
            {bookmark.title}
          </h3>
        </div>
        <div className={`flex-shrink-0 ${ROW_HEIGHT} flex items-center justify-end`}>
          {isShared ? (
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
                      <div key={folder.id} className="text-xs mt-1 pt-1 border-t border-gray-700">
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
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium bg-green-50/70 dark:bg-green-900/20 text-green-600/90 dark:text-green-400/80 rounded-md border border-green-200/60 dark:border-green-800/40 cursor-help opacity-90">
                <Share2 className="h-3 w-3" />
                {totalSharedTeams > 0
                  ? t('bookmarks.sharedWithTeams', {
                      count: totalSharedTeams,
                      teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams'),
                    })
                  : t('bookmarks.shared')}
              </span>
            </Tooltip>
          ) : (
            <span className="invisible" aria-hidden>placeholder</span>
          )}
        </div>
      </header>

      {/* B) Content: flex-1, reserved rows — 8px rhythm, slug closer to tags */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Folder row — fixed height */}
        <div className={`flex flex-wrap items-center gap-1.5 flex-shrink-0 ${CONTENT_ROW} ${ROW_HEIGHT}`}>
          {bookmark.folders && bookmark.folders.length > 0 ? (
            <>
              {bookmark.folders.slice(0, 2).map((folder) => (
                <Badge
                  key={folder.id}
                  variant="secondary"
                  className="text-xs font-medium bg-blue-50/80 dark:bg-blue-900/15 text-blue-600/90 dark:text-blue-400/90 border-blue-200/70 dark:border-blue-800/40"
                >
                  <FolderIcon
                    iconName={folder.icon}
                    size={12}
                    className="text-blue-600/90 dark:text-blue-400/90 mr-1"
                  />
                  <span className="truncate max-w-[80px]">{folder.name}</span>
                </Badge>
              ))}
              {bookmark.folders.length > 2 && (
                <Tooltip
                  content={
                    <div className="space-y-1">
                      <div className="font-semibold mb-1">{t('bookmarks.folders')}</div>
                      {bookmark.folders.map((folder) => (
                        <div key={folder.id} className="text-xs flex items-center gap-1.5">
                          <FolderIcon iconName={folder.icon} size={12} className="text-blue-400" />
                          {folder.name}
                        </div>
                      ))}
                    </div>
                  }
                >
                  <Badge
                    variant="secondary"
                    className="text-xs cursor-help bg-blue-50/80 dark:bg-blue-900/15 text-blue-600/90 dark:text-blue-400/90"
                  >
                    +{bookmark.folders.length - 2}
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : (
            <div className={ROW_HEIGHT} aria-hidden />
          )}
        </div>

        {/* Tags row — fixed height, max 2 + "+N" (8px below folder) */}
        <div className={`flex flex-wrap items-center gap-1.5 flex-shrink-0 mt-2 ${CONTENT_ROW} ${ROW_HEIGHT}`}>
          {bookmark.tags && bookmark.tags.length > 0 ? (
            <>
              {bookmark.tags.slice(0, 2).map((tag) => (
                <Badge
                  key={tag.id}
                  variant="secondary"
                  className="text-xs font-medium px-1.5 py-0 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800/50"
                >
                  <TagIcon className="h-3 w-3 mr-1 shrink-0" />
                  <span className="truncate max-w-[72px]">{tag.name}</span>
                </Badge>
              ))}
              {bookmark.tags.length > 2 && (
                <Tooltip
                  content={
                    <div className="space-y-1">
                      <div className="font-semibold mb-1">{t('bookmarks.tags')}</div>
                      {bookmark.tags.map((tag) => (
                        <div key={tag.id} className="text-xs flex items-center gap-1.5">
                          <TagIcon className="h-3 w-3 text-purple-400" />
                          {tag.name}
                        </div>
                      ))}
                    </div>
                  }
                >
                  <Badge
                    variant="secondary"
                    className="text-xs cursor-help px-1.5 py-0 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300"
                  >
                    +{bookmark.tags.length - 2}
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : (
            <div className={ROW_HEIGHT} aria-hidden />
          )}
        </div>

        {/* Slug or spacer — URL-style text, no fill; 8px below tags */}
        <div className={`flex items-center gap-1 flex-shrink-0 mt-2 ${CONTENT_ROW} ${ROW_HEIGHT} min-w-0 group/slug`}>
          {bookmark.forwarding_enabled ? (
            <>
              <span className="text-xs font-mono text-muted-foreground truncate flex-1 min-w-0 group-hover/slug:underline decoration-muted-foreground/60">
                /{bookmark.slug}
              </span>
              <Tooltip content={t('bookmarks.copyUrl')}>
                <button
                  data-card-action
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyUrl();
                  }}
                  className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
                  aria-label={t('bookmarks.copyUrl')}
                >
                  <Copy className="h-3 w-3" />
                </button>
              </Tooltip>
            </>
          ) : (
            <div className={ROW_HEIGHT} aria-hidden />
          )}
        </div>
      </div>

      {/* C) Footer: fixed height, subtle top border — meta left, open + menu right */}
      <footer className="flex-shrink-0 mt-auto flex items-center justify-between gap-2 h-8 border-t border-border/40">
        <div className="text-[11px] text-muted-foreground/90 truncate min-w-0">
          {t('bookmarks.clicks')}: {typeof bookmark.access_count === 'number' ? bookmark.access_count : '–'} ·{' '}
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
        <div className="flex items-center gap-0.5 flex-shrink-0" data-card-action>
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
