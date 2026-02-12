import { useState, useMemo } from 'react';
import { Share2, Tag as TagIcon, ExternalLink, Copy, Edit, Trash2, CheckSquare, Square, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import Favicon from '../Favicon';
import FolderIcon from '../FolderIcon';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Card } from '../ui/card';

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
}

interface BookmarkTableViewProps {
  bookmarks: Bookmark[];
  selectedBookmarks: Set<string>;
  onSelect: (id: string) => void;
  onSelectAll: () => void;
  onEdit: (bookmark: Bookmark) => void;
  onDelete: (id: string, name?: string) => void;
  onCopyUrl: (bookmark: Bookmark) => void;
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

  function formatDate(dateString?: string | null) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const cellClass = compact ? 'px-2 py-1.5' : 'px-4 py-3';

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            {bulkMode && (
              <TableHead className={cellClass}>
                <button
                  onClick={onSelectAll}
                  className="text-primary"
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
                className={`flex items-center gap-2 ${compact ? 'text-[10px]' : 'text-xs'} font-semibold uppercase tracking-wide hover:text-foreground`}
              >
                {t('bookmarks.name')}
                {getSortIcon('title')}
              </button>
            </TableHead>
            {!compact && (
              <TableHead className={cellClass}>
                <button
                  onClick={() => handleSort('url')}
                  className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide hover:text-foreground`}
                >
                  {t('bookmarks.url')}
                  {getSortIcon('url')}
                </button>
              </TableHead>
            )}
            {!compact && (
              <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                {t('bookmarks.folders')}
              </TableHead>
            )}
            {!compact && (
              <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                {t('bookmarks.tags')}
              </TableHead>
            )}
            {!compact && (
              <TableHead className={`${cellClass} text-xs font-semibold uppercase tracking-wide`}>
                {t('bookmarks.shared')}
              </TableHead>
            )}
            {!compact && (
              <TableHead className={cellClass}>
                <button
                  onClick={() => handleSort('last_accessed')}
                  className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide hover:text-foreground`}
                >
                  {t('bookmarks.sortRecentlyAccessed')}
                  {getSortIcon('last_accessed')}
                </button>
              </TableHead>
            )}
            <TableHead className={`${cellClass} text-right text-xs font-semibold uppercase tracking-wide`}>
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
                className={`${selectedBookmarks.has(bookmark.id) ? 'bg-primary/10' : ''} ${compact ? 'h-10' : ''}`}
                data-state={selectedBookmarks.has(bookmark.id) ? 'selected' : undefined}
              >
                {bulkMode && (
                  <TableCell className={cellClass}>
                    <button
                      onClick={() => onSelect(bookmark.id)}
                      className="text-blue-600 dark:text-blue-400"
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
                  <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
                    <div className={`flex-shrink-0 ${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 flex items-center justify-center border border-blue-100 dark:border-blue-800/50 overflow-hidden`}>
                      <Favicon url={bookmark.url} size={compact ? 12 : 16} />
                    </div>
                    <div className={`font-medium text-gray-900 dark:text-white ${compact ? 'text-xs' : 'text-[15px]'} truncate`}>
                      {bookmark.title}
                    </div>
                  </div>
                </TableCell>
                {!compact && (
                  <TableCell className={cellClass}>
                    <a
                      href={bookmark.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-gray-700 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 truncate max-w-xs block"
                    >
                      {bookmark.url}
                    </a>
                  </TableCell>
                )}
                {!compact && (
                  <TableCell className={cellClass}>
                    <div className="flex flex-wrap gap-1">
                      {bookmark.folders && bookmark.folders.length > 0 ? (
                        bookmark.folders.slice(0, 2).map((folder) => (
                          <span
                            key={folder.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-md"
                          >
                            <FolderIcon iconName={folder.icon} size={12} />
                            {folder.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </div>
                  </TableCell>
                )}
                {!compact && (
                  <TableCell className={cellClass}>
                    <div className="flex flex-wrap gap-1">
                      {bookmark.tags && bookmark.tags.length > 0 ? (
                        bookmark.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-md"
                          >
                            <TagIcon className="h-3 w-3" />
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </div>
                  </TableCell>
                )}
                {!compact && (
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
                )}
                {!compact && (
                  <TableCell className={cellClass}>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(bookmark.last_accessed_at)}
                    </span>
                  </TableCell>
                )}
                <TableCell className={cellClass}>
                  <div className={`flex items-center justify-end ${compact ? 'gap-1' : 'gap-2'}`}>
                    {bookmark.forwarding_enabled && !compact && (
                      <Tooltip content={`${window.location.origin}/go/${bookmark.slug}`}>
                        <button
                          onClick={() => onCopyUrl(bookmark)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                          title={t('bookmarks.copyUrl')}
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    )}
                    {onOpen ? (
                      <Button 
                        variant="primary" 
                        size="sm" 
                        icon={ExternalLink} 
                        className={compact ? 'text-[10px] px-1.5 py-0.5 h-6' : 'text-xs px-2'}
                        onClick={() => onOpen(bookmark)}
                      >
                        {compact ? '' : t('bookmarks.open')}
                      </Button>
                    ) : (
                      <a
                        href={bookmark.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button variant="primary" size="sm" icon={ExternalLink} className={compact ? 'text-[10px] px-1.5 py-0.5 h-6' : 'text-xs px-2'}>
                          {compact ? '' : t('bookmarks.open')}
                        </Button>
                      </a>
                    )}
                    {bookmark.bookmark_type === 'own' && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Edit}
                          onClick={() => onEdit(bookmark)}
                          title={t('common.edit')}
                          className={compact ? 'px-1 h-6' : 'px-2'}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          onClick={() => onDelete(bookmark.id, bookmark.title)}
                          title={t('common.delete')}
                          className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compact ? 'px-1 h-6' : 'px-2'}`}
                        />
                      </>
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
