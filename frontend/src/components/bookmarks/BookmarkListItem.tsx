import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import { safeHref } from '../../utils/safeHref';

interface Bookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  owner_user_key?: string;
  folders?: Array<{ id: string; name: string; icon?: string | null; shared_teams?: Array<{ id: string; name: string }> }>;
  tags?: Array<{ id: string; name: string }>;
  shared_teams?: Array<{ id: string; name: string }>;
  bookmark_type?: 'own' | 'shared';
}

interface BookmarkListItemProps {
  bookmark: Bookmark;
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyUrl: () => void;
  bulkMode: boolean;
  user: any;
  t: any;
}

export default function BookmarkListItem({
  bookmark,
  compact,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onCopyUrl,
  bulkMode,
  user: _user,
  t,
}: BookmarkListItemProps) {
  const totalSharedTeams = (bookmark.shared_teams?.length || 0) + 
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
  const isShared = totalSharedTeams > 0;

  return (
    <div
      className={`group bg-card rounded-lg border ${
        selected
          ? 'border-primary ring-2 ring-ring/30'
          : 'border-border hover:border-primary/50'
      } hover:shadow transition-all duration-200 ${compact ? 'p-2.5 min-h-[80px]' : 'p-4'}`}
    >
      <div className={`flex items-center ${compact ? 'gap-3' : 'gap-4'}`}>
        {bulkMode && (
          <button
            onClick={onSelect}
            className="flex-shrink-0 text-primary"
          >
            {selected ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
          </button>
        )}
        <div className={`flex-shrink-0 ${compact ? 'w-10 h-10' : 'w-12 h-12'} rounded-lg bg-gradient-to-br from-primary/15 to-primary/25 flex items-center justify-center border border-primary/25 overflow-hidden`}>
          <Favicon url={bookmark.url} size={compact ? 20 : 24} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium text-foreground mb-1">
                {bookmark.title}
              </h3>
              <p className={`${compact ? 'text-xs' : 'text-sm'} text-muted-foreground truncate ${compact ? 'mb-1' : 'mb-2'}`}>
                {bookmark.url}
              </p>
              <div className={`flex flex-wrap items-center gap-2 ${compact ? 'min-h-[24px]' : ''}`}>
                {bookmark.folders && bookmark.folders.length > 0 && (
                  bookmark.folders.slice(0, 1).map((folder) => (
                    <span
                      key={folder.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-primary/10 text-primary rounded-md`}
                    >
                      <FolderIcon iconName={folder.icon} size={12} />
                      {folder.name}
                    </span>
                  ))
                )}
                {bookmark.tags && bookmark.tags.length > 0 && (
                  bookmark.tags.slice(0, compact ? 2 : 3).map((tag) => (
                    <span
                      key={tag.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 ${compact ? 'text-xs' : 'text-xs'} font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-md`}
                    >
                      <TagIcon className="h-3 w-3" />
                      {tag.name}
                    </span>
                  ))
                )}
                {isShared && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md">
                    <Share2 className="h-3 w-3" />
                    {totalSharedTeams > 0 
                      ? t('bookmarks.sharedWithTeams', { count: totalSharedTeams, teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams') })
                      : t('bookmarks.shared')}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {bookmark.forwarding_enabled && (
                <Tooltip content={`${window.location.origin}/go/${bookmark.slug}`}>
                  <button
                    onClick={onCopyUrl}
                    className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    title={t('bookmarks.copyUrl')}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
              <a
                href={safeHref(bookmark.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="primary" size="sm" icon={ExternalLink} className={compact ? 'text-xs px-2' : ''}>
                  {t('bookmarks.open')}
                </Button>
              </a>
              {bookmark.bookmark_type === 'own' && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Edit}
                    onClick={onEdit}
                    title={t('common.edit')}
                    className="px-2"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={onDelete}
                    title={t('common.delete')}
                    className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 px-2"
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
