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
  selected,
  onSelect,
  onEdit,
  onDelete,
  onCopyUrl,
  bulkMode,
  user: _user,
  t,
}: BookmarkListItemProps) {
  const totalSharedTeams =
    (bookmark.shared_teams?.length || 0) +
    (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
  const isShared = totalSharedTeams > 0;

  return (
    <div
      className={`group rounded-xl border border-ghost bg-surface transition-colors ${
        selected ? 'ring-2 ring-ring/30 ring-offset-2 ring-offset-background' : 'hover:bg-surface-high'
      } p-4`}
    >
      <div className="flex items-center gap-4">
        {bulkMode && (
          <button type="button" onClick={onSelect} className="shrink-0 text-primary">
            {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          </button>
        )}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/25">
          <Favicon url={bookmark.url} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3 className="mb-1 text-sm font-medium text-foreground">{bookmark.title}</h3>
              <p className="mb-2 truncate text-sm text-muted-foreground">{bookmark.url}</p>
              <div className="flex min-h-[24px] flex-wrap items-center gap-2">
                {bookmark.folders && bookmark.folders.length > 0 && (
                  <>
                    {bookmark.folders.slice(0, 1).map((folder) => (
                      <span
                        key={folder.id}
                        className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-low px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                      >
                        <FolderIcon iconName={folder.icon} size={12} />
                        {folder.name}
                      </span>
                    ))}
                  </>
                )}
                {bookmark.tags && bookmark.tags.length > 0 && (
                  <>
                    {bookmark.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag.id}
                        className="inline-flex items-center gap-1 rounded-full bg-surface-low px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                      >
                        <TagIcon className="h-3 w-3 opacity-70" />
                        {tag.name}
                      </span>
                    ))}
                  </>
                )}
                {isShared && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-low px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    <Share2 className="h-3 w-3" />
                    {totalSharedTeams > 0
                      ? t('bookmarks.sharedWithTeams', {
                          count: totalSharedTeams,
                          teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams'),
                        })
                      : t('bookmarks.shared')}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {bookmark.forwarding_enabled && (
                <Tooltip content={`${window.location.origin}/go/${bookmark.slug}`}>
                  <button
                    type="button"
                    onClick={onCopyUrl}
                    className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-surface-high hover:text-foreground"
                    title={t('bookmarks.copyUrl')}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
              <a href={safeHref(bookmark.url)} target="_blank" rel="noopener noreferrer">
                <Button variant="primary" size="sm" icon={ExternalLink}>
                  {t('bookmarks.open')}
                </Button>
              </a>
              {bookmark.bookmark_type === 'own' && (
                <>
                  <Button variant="ghost" size="sm" icon={Edit} onClick={onEdit} title={t('common.edit')} className="px-2" />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={onDelete}
                    title={t('common.delete')}
                    className="px-2 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
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
