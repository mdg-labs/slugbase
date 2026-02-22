import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square, Pin } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import { Badge } from '../ui/badge';
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
  const totalSharedTeams = (bookmark.shared_teams?.length || 0) +
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
  const totalSharedUsers = (bookmark.shared_users?.length || 0) +
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

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={`group bg-card rounded-lg border ${
        selected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-border hover:border-primary/70 hover:bg-muted/50 hover:shadow-md'
      } transition-all duration-200 flex flex-col h-full min-h-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${compact ? 'p-2.5 min-h-[160px]' : 'p-2.5 min-h-[140px]'}`}
    >
      <div className="flex-shrink-0 mb-3">
        <div className="flex items-center gap-3">
          {bulkMode && (
            <button
              data-card-action
              onClick={(e) => { e.stopPropagation(); onSelect(); }}
              className="flex-shrink-0 text-primary"
            >
              {selected ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
            </button>
          )}
            <div className={`flex-shrink-0 ${compact ? 'w-9 h-9' : 'w-10 h-10'} rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30 overflow-hidden`}>
            <Favicon url={bookmark.url} size={compact ? 18 : 20} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className={`${compact ? 'text-xs font-semibold' : 'text-sm font-medium'} text-foreground line-clamp-2 leading-snug mb-1`}>
              {bookmark.title}
            </h3>
            {isShared && (
              <Tooltip
                content={
                  <div className="space-y-1">
                    <div className="font-semibold mb-1">{t('bookmarks.sharedWith')}</div>
                    {bookmark.shared_teams && bookmark.shared_teams.map((team) => (
                      <div key={team.id} className="text-xs">• {team.name}</div>
                    ))}
                    {bookmark.shared_users && bookmark.shared_users.map((user) => (
                      <div key={user.id} className="text-xs">• {user.name || user.email}</div>
                    ))}
                    {bookmark.folders && bookmark.folders.map((folder) => {
                      const hasShares = (folder.shared_teams?.length || 0) > 0 || (folder.shared_users?.length || 0) > 0;
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
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md border border-green-200 dark:border-green-800/50 cursor-help">
                  <Share2 className="h-3 w-3" />
                  {totalSharedTeams > 0
                    ? t('bookmarks.sharedWithTeams', { count: totalSharedTeams, teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams') })
                    : t('bookmarks.shared')}
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <div className={`flex-1 flex flex-col min-h-0 ${compact ? 'min-h-[100px]' : 'min-h-[120px]'} space-y-2`}>
        <div className="flex flex-wrap items-center gap-1.5 min-h-[24px] flex-shrink-0">
          {bookmark.folders && bookmark.folders.length > 0 ? (
            <>
              {bookmark.folders.slice(0, compact ? 1 : 2).map((folder) => (
                <Badge key={folder.id} variant="secondary" className="text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/50">
                  <FolderIcon iconName={folder.icon} size={12} className="text-blue-700 dark:text-blue-300 mr-1" />
                  {folder.name}
                </Badge>
              ))}
              {bookmark.folders.length > (compact ? 1 : 2) && (
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
                  <Badge variant="secondary" className="text-xs cursor-help bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300">
                    +{bookmark.folders.length - (compact ? 1 : 2)}
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : (
            <Badge variant="secondary" className="text-xs font-medium bg-gray-50 dark:bg-gray-900/20 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-800/50 opacity-60">
              <FolderIcon iconName={null} size={12} className="text-gray-600 dark:text-gray-400 mr-1" />
              {t('bookmarks.noFolder')}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 min-h-[24px] flex-shrink-0">
          {bookmark.tags && bookmark.tags.length > 0 ? (
            <>
              {bookmark.tags.slice(0, compact ? 2 : 3).map((tag) => (
                <Badge key={tag.id} variant="secondary" className="text-xs font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800/50">
                  <TagIcon className="h-3 w-3 mr-1" />
                  {tag.name}
                </Badge>
              ))}
              {bookmark.tags.length > (compact ? 2 : 3) && (
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
                  <Badge variant="secondary" className="text-xs cursor-help bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300">
                    +{bookmark.tags.length - (compact ? 2 : 3)}
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : (
            <Badge variant="secondary" className="text-xs font-medium bg-gray-50 dark:bg-gray-900/20 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-800/50 opacity-60">
              <TagIcon className="h-3 w-3 mr-1" />
              {t('bookmarks.noTags') || 'No Tags'}
            </Badge>
          )}
        </div>

        {(typeof bookmark.access_count === 'number' || bookmark.last_accessed_at != null) && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground flex-shrink-0">
            <span>{t('bookmarks.clicks')}: {typeof bookmark.access_count === 'number' ? bookmark.access_count : '-'}</span>
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
        )}

        {bookmark.forwarding_enabled && (
          <div className={`flex items-center gap-1.5 flex-shrink-0 ${compact ? 'px-2 py-1.5' : 'px-2 py-1.5'}`}>
            <Badge variant="outline" className="text-xs font-mono">
              {t('bookmarks.slug')}: /{bookmark.slug}
            </Badge>
            <Tooltip content={t('bookmarks.copyUrl')}>
              <button
                data-card-action
                type="button"
                onClick={(e) => { e.stopPropagation(); onCopyUrl(); }}
                className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors"
                aria-label={t('bookmarks.copyUrl')}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <div className={`flex gap-1.5 pt-2.5 shrink-0 border-t border-border ${compact ? 'pt-2' : ''}`} data-card-action>
        {onOpen ? (
          <Tooltip content={t('bookmarks.open')}>
            <Button variant="ghost" size="sm" icon={ExternalLink} iconClassName="h-3.5 w-3.5 stroke-[1.5]" className="flex-shrink-0 h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onOpen(); }} aria-label={t('bookmarks.open')} />
          </Tooltip>
        ) : (
          <Tooltip content={t('bookmarks.open')}>
            <a
              href={safeHref(bookmark.url)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex-shrink-0"
            >
              <Button variant="ghost" size="sm" icon={ExternalLink} iconClassName="h-3.5 w-3.5 stroke-[1.5]" className="h-8 w-8 p-0" aria-label={t('bookmarks.open')} />
            </a>
          </Tooltip>
        )}
        {bookmark.bookmark_type === 'own' && (
          <>
            {onPinToggle && (
              <Tooltip content={bookmark.pinned ? t('bookmarks.pinned') : t('bookmarks.pin')}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Pin}
                  iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                  className={`flex-shrink-0 h-8 w-8 p-0 ${bookmark.pinned ? 'text-primary' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onPinToggle(); }}
                  aria-label={bookmark.pinned ? t('bookmarks.pinned') : t('bookmarks.pin')}
                  aria-pressed={bookmark.pinned}
                />
              </Tooltip>
            )}
            {onShare && (
              <Tooltip content={t('sharing.shareBookmark')}>
                <Button variant="ghost" size="sm" icon={Share2} iconClassName="h-3.5 w-3.5 stroke-[1.5]" className="flex-shrink-0 h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onShare(); }} aria-label={t('sharing.shareBookmark')} />
              </Tooltip>
            )}
            <Tooltip content={t('common.edit')}>
              <Button variant="ghost" size="sm" icon={Edit} iconClassName="h-3.5 w-3.5 stroke-[1.5]" className="flex-shrink-0 h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onEdit(); }} aria-label={t('common.edit')} />
            </Tooltip>
            <Tooltip content={t('bookmarks.copyUrl')}>
              <Button variant="ghost" size="sm" icon={Copy} iconClassName="h-3.5 w-3.5 stroke-[1.5]" className="flex-shrink-0 h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onCopyUrl(); }} aria-label={t('bookmarks.copyUrl')} />
            </Tooltip>
            <Tooltip content={t('common.delete')}>
              <Button variant="ghost" size="sm" icon={Trash2} iconClassName="h-3.5 w-3.5 stroke-[1.5]" className="flex-shrink-0 h-8 w-8 p-0 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={(e) => { e.stopPropagation(); onDelete(); }} aria-label={t('common.delete')} />
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
