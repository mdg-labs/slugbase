import { useState, useMemo } from 'react';
import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square, ArrowUpDown, ArrowUp, ArrowDown, MoreHorizontal } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import { Badge } from '../ui/badge';
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
  compact?: boolean;
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
  compact = false,
}: BookmarkTableViewProps) {
  const [sortColumn, setSortColumn] = useState<'title' | 'url' | 'last_accessed' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const sortedBookmarks = useMemo(() => {
    if (!sortColumn) return bookmarks;
    
    return [...bookmarks].sort((a, b) => {
      let aVal: any;
      let bVal: any;
      
      switch (sortColumn) {
        case 'title':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'url':
          aVal = a.url.toLowerCase();
          bVal = b.url.toLowerCase();
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

  function handleSort(column: 'title' | 'url' | 'last_accessed') {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  function getSortIcon(column: 'title' | 'url' | 'last_accessed') {
    const iconSize = compact ? 'h-3 w-3' : 'h-4 w-4';
    if (sortColumn !== column) {
      return <ArrowUpDown className={`${iconSize} text-gray-400`} />;
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

  const cellClass = compact ? 'px-2 py-1.5' : 'px-4 py-3';
  const headClass = compact ? 'text-[10px]' : 'text-xs';

  return (
    <Card className={compact ? 'overflow-x-auto' : ''}>
      <Table>
        <TableHeader>
          <TableRow>
            {bulkMode && (
              <TableHead className={cellClass}>
                <button
                  onClick={onSelectAll}
                  className="text-primary"
                  aria-label={t('bookmarks.selectAll')}
                >
                  {selectedBookmarks.size === bookmarks.length ? (
                    <CheckSquare className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
                  ) : (
                    <Square className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
                  )}
                </button>
              </TableHead>
            )}
            <TableHead className={cellClass}>
              <button
                onClick={() => handleSort('title')}
                className={`flex items-center gap-2 ${headClass} font-semibold uppercase tracking-wide hover:text-foreground`}
              >
                {t('bookmarks.name')}
                {getSortIcon('title')}
              </button>
            </TableHead>
            {compact ? (
              <>
                <TableHead className={`${cellClass} ${headClass} font-semibold uppercase tracking-wide`}>{t('bookmarks.folders')}</TableHead>
                <TableHead className={`${cellClass} ${headClass} font-semibold uppercase tracking-wide`}>{t('bookmarks.tags')}</TableHead>
                <TableHead className={`${cellClass} ${headClass} font-semibold uppercase tracking-wide`}>{t('bookmarks.clicks')}</TableHead>
                <TableHead className={`${cellClass} ${headClass} font-semibold uppercase tracking-wide`}>{t('bookmarks.lastOpened')}</TableHead>
                <TableHead className={`${cellClass} ${headClass} font-semibold uppercase tracking-wide`}>{t('bookmarks.sortRecentlyAdded')}</TableHead>
              </>
            ) : (
              <>
                <TableHead className={cellClass}>
                  <button
                    onClick={() => handleSort('url')}
                    className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide hover:text-foreground`}
                  >
                    {t('bookmarks.url')}
                    {getSortIcon('url')}
                  </button>
                </TableHead>
                <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                  {t('bookmarks.folders')}
                </TableHead>
                <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                  {t('bookmarks.tags')}
                </TableHead>
                <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                  {t('bookmarks.shared')}
                </TableHead>
                <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                  {t('bookmarks.clicks')}
                </TableHead>
                <TableHead className={cellClass}>
                  <button
                    onClick={() => handleSort('last_accessed')}
                    className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide hover:text-foreground`}
                  >
                    {t('bookmarks.lastOpened')}
                    {getSortIcon('last_accessed')}
                  </button>
                </TableHead>
                <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                  {t('bookmarks.sortRecentlyAdded')}
                </TableHead>
              </>
            )}
            <TableHead className={`${cellClass} text-right ${headClass} font-semibold uppercase tracking-wide`}>
              {t('common.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedBookmarks.map((bookmark) => {
            const totalSharedTeams = (bookmark.shared_teams?.length || 0) + 
              (bookmark.folders?.reduce((sum, f) => sum + (f.shared_teams?.length || 0), 0) || 0);
            const isShared = totalSharedTeams > 0;
            
            return (
              <TableRow
                key={bookmark.id}
                className={`group ${selectedBookmarks.has(bookmark.id) ? 'bg-primary/10' : ''} ${compact ? 'h-10' : ''}`}
                data-state={selectedBookmarks.has(bookmark.id) ? 'selected' : undefined}
              >
                {bulkMode && (
                  <TableCell className={cellClass}>
                    <button
                      onClick={() => onSelect(bookmark.id)}
                      className="text-primary"
                      aria-label={t('bookmarks.selectAll')}
                    >
                      {selectedBookmarks.has(bookmark.id) ? (
                        <CheckSquare className={`${compact ? 'h-4 w-4' : 'h-5 w-5'}`} />
                      ) : (
                        <Square className={`${compact ? 'h-4 w-4' : 'h-5 w-5'}`} />
                      )}
                    </button>
                  </TableCell>
                )}
                <TableCell className={cellClass}>
                  <a
                    href={safeHref(bookmark.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => { if (onOpen) { e.preventDefault(); onOpen(bookmark); } }}
                    className={`flex items-center ${compact ? 'gap-2' : 'gap-3'} group/title hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded`}
                  >
                    <div className={`flex-shrink-0 ${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-gradient-to-br from-primary/15 to-primary/25 flex items-center justify-center border border-primary/25 overflow-hidden`}>
                      <Favicon url={bookmark.url} size={compact ? 12 : 16} />
                    </div>
                    <div className={`font-semibold text-foreground ${compact ? 'text-xs' : 'text-sm'} truncate`}>
                      {bookmark.title}
                    </div>
                  </a>
                </TableCell>
                {compact ? (
                  <>
                    <TableCell className={cellClass}>
                      <div className="flex flex-wrap gap-0.5 max-w-[120px]">
                        {bookmark.folders && bookmark.folders.length > 0 ? (
                          bookmark.folders.slice(0, 1).map((folder) => (
                            <span key={folder.id} className="text-xs text-muted-foreground truncate">
                              <FolderIcon iconName={folder.icon} size={10} className="inline mr-0.5" />
                              {folder.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={cellClass}>
                      <div className="flex flex-wrap gap-0.5 max-w-[100px] truncate">
                        {bookmark.tags && bookmark.tags.length > 0 ? (
                          <span className="text-xs text-muted-foreground truncate" title={bookmark.tags.map(t => t.name).join(', ')}>
                            {bookmark.tags.slice(0, 2).map(t => t.name).join(', ')}
                            {bookmark.tags.length > 2 ? ` +${bookmark.tags.length - 2}` : ''}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={cellClass}>
                      <span className="text-xs text-muted-foreground">
                        {typeof bookmark.access_count === 'number' ? bookmark.access_count : '-'}
                      </span>
                    </TableCell>
                    <TableCell className={cellClass}>
                      {bookmark.last_accessed_at ? (
                        <Tooltip content={formatFullDateTime(bookmark.last_accessed_at)}>
                          <span className="text-xs text-muted-foreground cursor-help">
                            {formatRelativeTime(bookmark.last_accessed_at)}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('bookmarks.never')}</span>
                      )}
                    </TableCell>
                    <TableCell className={cellClass}>
                      <span className="text-xs text-muted-foreground">
                        {formatCreated(bookmark.created_at)}
                      </span>
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell className={cellClass}>
                      <a
                        href={safeHref(bookmark.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-foreground truncate max-w-xs block"
                      >
                        {bookmark.url}
                      </a>
                    </TableCell>
                    <TableCell className={cellClass}>
                      <div className="flex flex-wrap gap-1">
                        {bookmark.folders && bookmark.folders.length > 0 ? (
                          bookmark.folders.slice(0, 2).map((folder) => (
                            <Badge key={folder.id} variant="secondary" className="text-xs font-medium bg-primary/10 text-primary">
                              <FolderIcon iconName={folder.icon} size={12} className="mr-1" />
                              {folder.name}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={cellClass}>
                      <div className="flex flex-wrap gap-1">
                        {bookmark.tags && bookmark.tags.length > 0 ? (
                          bookmark.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag.id} variant="secondary" className="text-xs font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300">
                              <TagIcon className="h-3 w-3 mr-1" />
                              {tag.name}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={cellClass}>
                      {isShared ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md">
                          <Share2 className="h-3 w-3" />
                          {totalSharedTeams > 0 
                            ? t('bookmarks.sharedWithTeams', { count: totalSharedTeams, teams: totalSharedTeams === 1 ? t('common.team') : t('common.teams') })
                            : t('bookmarks.shared')}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className={cellClass}>
                      <span className="text-xs text-muted-foreground">
                        {typeof bookmark.access_count === 'number' ? bookmark.access_count : '-'}
                      </span>
                    </TableCell>
                    <TableCell className={cellClass}>
                      {bookmark.last_accessed_at ? (
                        <Tooltip content={formatFullDateTime(bookmark.last_accessed_at)}>
                          <span className="text-xs text-muted-foreground cursor-help">
                            {formatRelativeTime(bookmark.last_accessed_at)}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('bookmarks.never')}</span>
                      )}
                    </TableCell>
                    <TableCell className={cellClass}>
                      <span className="text-xs text-muted-foreground">
                        {formatCreated(bookmark.created_at)}
                      </span>
                    </TableCell>
                  </>
                )}
                <TableCell className={cellClass}>
                  <div className={`flex items-center justify-end gap-1 min-w-[4.5rem]`}>
                    {onOpen ? (
                      <Tooltip content={t('bookmarks.open')}>
                        <Button variant="ghost" size="sm" icon={ExternalLink} className="h-8 w-8 p-0 flex-shrink-0" onClick={() => onOpen(bookmark)} aria-label={t('bookmarks.open')} />
                      </Tooltip>
                    ) : (
                      <Tooltip content={t('bookmarks.open')}>
                        <a href={safeHref(bookmark.url)} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
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
                            className="h-8 w-8 p-0 flex-shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
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
