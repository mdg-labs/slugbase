import { useState, useMemo } from 'react';
import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square, ArrowUpDown, ArrowUp, ArrowDown, MoreHorizontal } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Card } from '../ui/card';
import { safeHref } from '../../utils/safeHref';
import { formatRelativeTime, formatFullDateTime } from '../../utils/formatRelativeTime';

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
  last_accessed_at?: string | null | undefined;
  access_count?: number;
  created_at?: string;
}

interface BookmarkTableViewProps {
  bookmarks: Bookmark[];
  selectedBookmarks: Set<string>;
  onSelect: (id: string) => void;
  onSelectAll: () => void;
  onEdit: (bookmark: Bookmark) => void;
  onDelete: (id: string, name?: string) => void;
  onCopyUrl: (bookmark: Bookmark) => void;
  onShare?: (bookmark: Bookmark) => void;
  onOpen?: (bookmark: Bookmark) => void;
  bulkMode: boolean;
  user: any;
  t: any;
}

const cellClass = 'px-4 py-3';
const headClass = `${cellClass} text-[10px] font-bold uppercase tracking-widest text-muted-foreground`;

function tagPillClassName(extra = '') {
  return `inline-flex max-w-full items-center gap-1 rounded-full bg-surface-low px-2.5 py-0.5 text-xs font-medium text-muted-foreground ${extra}`;
}

export default function BookmarkTableView({
  bookmarks,
  selectedBookmarks,
  onSelect,
  onSelectAll,
  onEdit,
  onDelete,
  onCopyUrl,
  onShare,
  onOpen,
  bulkMode,
  user: _user,
  t,
}: BookmarkTableViewProps) {
  const [sortColumn, setSortColumn] = useState<'title' | 'slug' | 'last_accessed' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const sortedBookmarks = useMemo(() => {
    if (!sortColumn) return bookmarks;

    return [...bookmarks].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortColumn) {
        case 'title':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'slug':
          aVal = (a.slug || '').toLowerCase();
          bVal = (b.slug || '').toLowerCase();
          break;
        case 'last_accessed':
          aVal = a.last_accessed_at ? new Date(a.last_accessed_at).getTime() : 0;
          bVal = b.last_accessed_at ? new Date(b.last_accessed_at).getTime() : 0;
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [bookmarks, sortColumn, sortDirection]);

  function handleSort(column: 'title' | 'slug' | 'last_accessed') {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  function getSortIcon(column: 'title' | 'slug' | 'last_accessed') {
    const iconSize = 'h-4 w-4';
    if (sortColumn !== column) {
      return <ArrowUpDown className={`${iconSize} text-muted-foreground`} />;
    }
    return sortDirection === 'asc' ? (
      <ArrowUp className={`${iconSize} text-primary`} />
    ) : (
      <ArrowDown className={`${iconSize} text-primary`} />
    );
  }

  function formatCreated(dateString?: string | null) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString();
  }

  return (
    <Card className="overflow-hidden rounded-2xl border border-ghost glass shadow-xl">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-ghost bg-surface-low/50 hover:bg-transparent">
            {bulkMode && (
              <TableHead className={`${cellClass} w-12`}>
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="text-primary"
                  aria-label={t('bookmarks.selectAll')}
                >
                  {selectedBookmarks.size === bookmarks.length ? (
                    <CheckSquare className="h-5 w-5" />
                  ) : (
                    <Square className="h-5 w-5" />
                  )}
                </button>
              </TableHead>
            )}
            <TableHead className={headClass}>
              <button
                type="button"
                onClick={() => handleSort('title')}
                className="flex items-center gap-2 font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                {t('bookmarks.name')}
                {getSortIcon('title')}
              </button>
            </TableHead>
            <TableHead className={headClass}>
              <button
                type="button"
                onClick={() => handleSort('slug')}
                className="flex items-center gap-2 font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                {t('bookmarks.slugColumn')}
                {getSortIcon('slug')}
              </button>
            </TableHead>
            <TableHead className={headClass}>{t('bookmarks.folders')}</TableHead>
            <TableHead className={headClass}>{t('bookmarks.tags')}</TableHead>
            <TableHead className={headClass}>{t('bookmarks.shared')}</TableHead>
            <TableHead className={headClass}>{t('bookmarks.clicks')}</TableHead>
            <TableHead className={headClass}>
              <button
                type="button"
                onClick={() => handleSort('last_accessed')}
                className="flex items-center gap-2 font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                {t('bookmarks.lastOpened')}
                {getSortIcon('last_accessed')}
              </button>
            </TableHead>
            <TableHead className={headClass}>{t('bookmarks.sortRecentlyAdded')}</TableHead>
            <TableHead className={`${headClass} text-right`}>{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedBookmarks.map((bookmark) => {
            const totalSharedTeams =
              (bookmark.shared_teams?.length || 0) +
              (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
            const isShared = totalSharedTeams > 0;

            return (
              <TableRow
                key={bookmark.id}
                className={`group border-0 border-b border-ghost/30 transition-colors hover:bg-surface-high/50 ${selectedBookmarks.has(bookmark.id) ? 'bg-primary/10' : ''}`}
                data-state={selectedBookmarks.has(bookmark.id) ? 'selected' : undefined}
              >
                {bulkMode && (
                  <TableCell className={cellClass}>
                    <button
                      type="button"
                      onClick={() => onSelect(bookmark.id)}
                      className="text-primary"
                      aria-label={t('bookmarks.selectAll')}
                    >
                      {selectedBookmarks.has(bookmark.id) ? (
                        <CheckSquare className="h-5 w-5" />
                      ) : (
                        <Square className="h-5 w-5" />
                      )}
                    </button>
                  </TableCell>
                )}
                <TableCell className={cellClass}>
                  <a
                    href={safeHref(bookmark.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      if (onOpen) {
                        e.preventDefault();
                        onOpen(bookmark);
                      }
                    }}
                    className="group/title flex items-center gap-3 rounded hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/25">
                      <Favicon url={bookmark.url} size={16} />
                    </div>
                    <div className="truncate text-sm font-semibold text-foreground">{bookmark.title}</div>
                  </a>
                </TableCell>
                <TableCell className={cellClass}>
                  {bookmark.forwarding_enabled && bookmark.slug ? (
                    <div className="flex max-w-[14rem] items-center gap-2">
                      <Tooltip content={`${window.location.origin}/go/${bookmark.slug}`}>
                        <span className="truncate font-mono text-sm text-muted-foreground">/{bookmark.slug}</span>
                      </Tooltip>
                      <Tooltip content={t('bookmarks.copyUrl')}>
                        <button
                          type="button"
                          onClick={() => onCopyUrl(bookmark)}
                          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-surface-high hover:text-foreground"
                          aria-label={t('bookmarks.copyUrl')}
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className={cellClass}>
                  <div className="flex flex-wrap gap-1">
                    {bookmark.folders && bookmark.folders.length > 0 ? (
                      bookmark.folders.slice(0, 3).map((folder) => (
                        <span key={folder.id} className={tagPillClassName('max-w-[10rem] truncate')}>
                          <FolderIcon iconName={folder.icon} size={12} className="shrink-0" />
                          {folder.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className={cellClass}>
                  <div className="flex flex-wrap gap-1">
                    {bookmark.tags && bookmark.tags.length > 0 ? (
                      bookmark.tags.slice(0, 4).map((tag) => (
                        <span key={tag.id} className={tagPillClassName()}>
                          <TagIcon className="h-3 w-3 shrink-0 opacity-70" />
                          {tag.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className={cellClass}>
                  {isShared ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-low px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      <Share2 className="h-3 w-3" />
                      {totalSharedTeams > 0
                        ? t('bookmarks.sharedWithTeams', {
                            count: totalSharedTeams,
                            teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams'),
                          })
                        : t('bookmarks.shared')}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className={cellClass}>
                  <span className="text-sm text-muted-foreground">
                    {typeof bookmark.access_count === 'number' ? bookmark.access_count : '—'}
                  </span>
                </TableCell>
                <TableCell className={cellClass}>
                  {bookmark.last_accessed_at ? (
                    <Tooltip content={formatFullDateTime(bookmark.last_accessed_at)}>
                      <span className="cursor-help text-sm text-muted-foreground">
                        {formatRelativeTime(bookmark.last_accessed_at)}
                      </span>
                    </Tooltip>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t('bookmarks.never')}</span>
                  )}
                </TableCell>
                <TableCell className={cellClass}>
                  <span className="text-sm text-muted-foreground">{formatCreated(bookmark.created_at)}</span>
                </TableCell>
                <TableCell className={cellClass}>
                  <div className="flex min-w-[4.5rem] items-center justify-end gap-1">
                    {onOpen ? (
                      <Tooltip content={t('bookmarks.open')}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={ExternalLink}
                          className="h-8 w-8 shrink-0 p-0"
                          onClick={() => onOpen(bookmark)}
                          aria-label={t('bookmarks.open')}
                        />
                      </Tooltip>
                    ) : (
                      <Tooltip content={t('bookmarks.open')}>
                        <a href={safeHref(bookmark.url)} target="_blank" rel="noopener noreferrer" className="shrink-0">
                          <Button variant="ghost" size="sm" icon={ExternalLink} className="h-8 w-8 p-0" aria-label={t('bookmarks.open')} />
                        </a>
                      </Tooltip>
                    )}
                    {bookmark.bookmark_type === 'own' && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={MoreHorizontal}
                            className="h-8 w-8 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                            aria-label={t('bookmarks.moreActions')}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {bookmark.forwarding_enabled && (
                            <DropdownMenuItem onClick={() => onCopyUrl(bookmark)}>
                              <Copy className="h-4 w-4" />
                              {t('bookmarks.copyUrl')}
                            </DropdownMenuItem>
                          )}
                          {onShare && (
                            <DropdownMenuItem onClick={() => onShare(bookmark)}>
                              <Share2 className="h-4 w-4" />
                              {t('sharing.shareBookmark')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => onEdit(bookmark)}>
                            <Edit className="h-4 w-4" />
                            {t('common.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onDelete(bookmark.id, bookmark.title)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
