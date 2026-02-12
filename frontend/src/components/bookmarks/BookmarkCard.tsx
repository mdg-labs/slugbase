import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';

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
}

interface BookmarkCardProps {
  bookmark: Bookmark;
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyUrl: () => void;
  onOpen?: () => void;
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
  onOpen,
  bulkMode,
  t,
}: BookmarkCardProps) {
  const totalSharedTeams = (bookmark.shared_teams?.length || 0) + 
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
  const totalSharedUsers = (bookmark.shared_users?.length || 0) + 
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_users?.length || 0), 0) || 0);
  const isShared = totalSharedTeams > 0 || totalSharedUsers > 0;

  return (
    <div
      className={`group bg-card rounded-lg border ${
        selected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-border hover:border-primary/70'
      } hover:shadow-lg transition-all duration-200 flex flex-col h-full min-h-0 ${compact ? 'p-2.5 min-h-[200px]' : 'p-4'}`}
    >
      {/* Content area - sticks to top */}
      <div className={`flex-shrink-0 space-y-3 ${compact ? 'space-y-2' : ''}`}>
        {/* Header with icon and title */}
        <div className="flex items-start gap-3">
          {bulkMode && (
            <button
              onClick={onSelect}
              className="flex-shrink-0 mt-0.5 text-blue-600 dark:text-blue-400"
            >
              {selected ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
            </button>
          )}
          <div className={`flex-shrink-0 ${compact ? 'w-10 h-10' : 'w-12 h-12'} rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 flex items-center justify-center border border-blue-100 dark:border-blue-800/50 overflow-hidden`}>
            <Favicon url={bookmark.url} size={compact ? 20 : 24} />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className={`${compact ? 'text-xs' : 'text-sm'} font-bold text-gray-900 dark:text-white line-clamp-2 leading-snug mb-1.5`} style={{ fontSize: compact ? '0.75rem' : '0.875rem', fontWeight: 700 }}>
              {bookmark.title}
            </h3>
            {isShared && (
              <Tooltip
                content={
                  <div className="space-y-1">
                    <div className="font-semibold mb-1">{t('bookmarks.sharedWith')}</div>
                    {bookmark.shared_teams && bookmark.shared_teams.map((team) => (
                      <div key={team.id} className="text-xs">
                        • {team.name}
                      </div>
                    ))}
                    {bookmark.shared_users && bookmark.shared_users.map((user) => (
                      <div key={user.id} className="text-xs">
                        • {user.name || user.email}
                      </div>
                    ))}
                    {bookmark.folders && bookmark.folders.map((folder) => {
                      const hasShares = (folder.shared_teams && folder.shared_teams.length > 0) || (folder.shared_users && folder.shared_users.length > 0);
                      if (!hasShares) return null;
                      return (
                        <div key={folder.id} className="text-xs mt-1 pt-1 border-t border-gray-700">
                          <div className="font-semibold mb-0.5">{folder.name}:</div>
                          {folder.shared_teams && folder.shared_teams.map((team) => (
                            <div key={team.id} className="text-xs pl-2">
                              • {team.name}
                            </div>
                          ))}
                          {folder.shared_users && folder.shared_users.map((user) => (
                            <div key={user.id} className="text-xs pl-2">
                              • {user.name || user.email}
                            </div>
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

        {/* URL */}
        <p className={`${compact ? 'text-xs' : 'text-xs'} text-gray-700 dark:text-gray-200 truncate flex items-center gap-1.5 px-1`}>
          <ExternalLink className={`${compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} flex-shrink-0 opacity-80`} />
          <span className="truncate">{bookmark.url}</span>
        </p>

        {/* Folders - Always show one line */}
        <div className="flex flex-wrap items-center gap-1.5 min-h-[24px]">
          {bookmark.folders && bookmark.folders.length > 0 ? (
            <>
              {bookmark.folders.slice(0, compact ? 1 : 2).map((folder) => (
                <span
                  key={folder.id}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-md border border-blue-200 dark:border-blue-800/50`}
                >
                  <FolderIcon iconName={folder.icon} size={12} className="text-blue-700 dark:text-blue-300" />
                  {folder.name}
                </span>
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
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-md border border-blue-200 dark:border-blue-800/50 cursor-help`}>
                    +{bookmark.folders.length - (compact ? 1 : 2)}
                  </span>
                </Tooltip>
              )}
            </>
          ) : (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-gray-50 dark:bg-gray-900/20 text-gray-600 dark:text-gray-400 rounded-md border border-gray-200 dark:border-gray-800/50 opacity-60`}>
              <FolderIcon iconName={null} size={12} className="text-gray-600 dark:text-gray-400" />
              {t('bookmarks.noFolder')}
            </span>
          )}
        </div>

        {/* Tags - Always show one line */}
        <div className="flex flex-wrap items-center gap-1.5 min-h-[24px]">
          {bookmark.tags && bookmark.tags.length > 0 ? (
            <>
              {bookmark.tags.slice(0, compact ? 2 : 3).map((tag) => (
                <span
                  key={tag.id}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-md border border-purple-200 dark:border-purple-800/50`}
                >
                  <TagIcon className="h-3 w-3" />
                  {tag.name}
                </span>
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
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-md border border-purple-200 dark:border-purple-800/50 cursor-help`}>
                    +{bookmark.tags.length - (compact ? 2 : 3)}
                  </span>
                </Tooltip>
              )}
            </>
          ) : (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-gray-50 dark:bg-gray-900/20 text-gray-600 dark:text-gray-400 rounded-md border border-gray-200 dark:border-gray-800/50 opacity-60`}>
              <TagIcon className="h-3 w-3" />
              {t('bookmarks.noTags') || 'No Tags'}
            </span>
          )}
        </div>

        {/* Forwarding URL */}
        {bookmark.forwarding_enabled && (
          <div className={`flex items-center gap-2 ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} bg-gray-50 dark:bg-gray-900/30 rounded-lg border border-gray-200 dark:border-gray-700`}>
            <code className={`${compact ? 'text-xs' : 'text-xs'} font-mono text-gray-700 dark:text-gray-300 truncate flex-1`}>
              /{bookmark.slug}
            </code>
            <button
              onClick={onCopyUrl}
              className="flex-shrink-0 p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title={t('bookmarks.copyUrl')}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Spacer - pushes action row to bottom */}
      <div className="flex-1 min-h-0" />

      {/* Action row - sticks to bottom of card */}
      <div className={`flex gap-2 pt-3 shrink-0 border-t border-border ${compact ? 'pt-2' : ''}`}>
          {onOpen ? (
            <Button 
              variant="primary" 
              size="sm" 
              icon={ExternalLink} 
              className={`flex-1 ${compact ? 'text-xs px-2 py-1' : 'text-xs'}`}
              onClick={onOpen}
            >
              {t('bookmarks.open')}
            </Button>
          ) : (
            <a
              href={bookmark.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1"
            >
              <Button variant="primary" size="sm" icon={ExternalLink} className={`w-full ${compact ? 'text-xs px-2 py-1' : 'text-xs'}`}>
                {t('bookmarks.open')}
              </Button>
            </a>
          )}
          {bookmark.bookmark_type === 'own' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={Edit}
                onClick={onEdit}
                title={t('common.edit')}
                className={`${compact ? 'px-1.5' : 'px-2'}`}
              />
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                onClick={onDelete}
                title={t('common.delete')}
                className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compact ? 'px-1.5' : 'px-2'}`}
              />
            </>
          )}
        </div>
    </div>
  );
}
