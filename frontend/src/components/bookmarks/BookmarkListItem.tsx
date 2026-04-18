import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import { safeHref } from '../../utils/safeHref';
import { cn } from '@/lib/utils';

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

  const urlDisplay = bookmark.url.replace(/^https?:\/\//, '');

  return (
    <div
      className={cn(
        'bm-row group rounded-md border border-transparent px-3 py-2 transition-colors',
        selected ? 'border-[var(--accent-ring)] bg-[var(--accent-bg)]' : 'hover:border-[var(--border)] hover:bg-[var(--bg-1)]'
      )}
    >
      <div className="flex items-center gap-3">
        {bulkMode && (
          <button type="button" onClick={onSelect} className="shrink-0 text-[var(--accent)]">
            {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          </button>
        )}
        <div className="r-ico flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded bg-[var(--bg-3)]">
          <Favicon url={bookmark.url} size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3 className="r-t text-[12.5px] font-medium text-[var(--fg-0)]">{bookmark.title}</h3>
              <p className="r-u mt-0.5 truncate font-mono text-[11px] text-[var(--fg-3)]">{urlDisplay}</p>
              <div className="mt-2 flex min-h-[24px] flex-wrap items-center gap-2">
                {bookmark.folders && bookmark.folders.length > 0 && (
                  <>
                    {bookmark.folders.slice(0, 1).map((folder) => (
                      <span
                        key={folder.id}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--fg-2)]"
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
                        className="tag inline-flex items-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--fg-1)]"
                      >
                        <TagIcon className="h-3 w-3 opacity-70" />
                        {tag.name}
                      </span>
                    ))}
                  </>
                )}
                {isShared && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--fg-2)]">
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
                    className="rounded-md p-2 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
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
                    className="px-2 text-[var(--danger)] hover:text-[var(--danger)]"
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
