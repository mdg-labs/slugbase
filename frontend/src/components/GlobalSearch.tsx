import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useSearchCommand } from '../contexts/SearchCommandContext';
import {
  Bookmark,
  Folder,
  Tag,
  ExternalLink,
  Plus,
  ArrowRight,
} from 'lucide-react';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { canAccessWorkspaceAdmin } from '../utils/adminAccess';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command';

interface SearchResult {
  id: string;
  type: 'bookmark' | 'folder' | 'tag' | 'navigation' | 'action';
  title: string;
  url?: string;
  icon?: string | null;
  action?: () => void;
  path?: string;
}

export default function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { user } = useAuth();
  const { open, setOpen, openSearch } = useSearchCommand();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const showAdmin = canAccessWorkspaceAdmin(user);

  const navigationItems: SearchResult[] = useMemo(() => [
    { type: 'navigation', title: t('bookmarks.title'), path: `${prefix}/bookmarks`.replace(/\/+/g, '/') || '/bookmarks', id: 'nav-bookmarks' },
    { type: 'navigation', title: t('folders.title'), path: `${prefix}/folders`.replace(/\/+/g, '/') || '/folders', id: 'nav-folders' },
    { type: 'navigation', title: t('tags.title'), path: `${prefix}/tags`.replace(/\/+/g, '/') || '/tags', id: 'nav-tags' },
    ...(showAdmin ? [{ type: 'navigation' as const, title: t('admin.title'), path: `${prefix}/admin`.replace(/\/+/g, '/') || '/admin', id: 'nav-admin' }] : []),
  ], [showAdmin, t, prefix]);

  const actionItems: SearchResult[] = useMemo(() => [
    { type: 'action', title: t('bookmarks.create'), path: `${prefix}/bookmarks`, id: 'action-create-bookmark', action: () => navigate(`${prefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true') },
    { type: 'action', title: t('folders.create'), path: `${prefix}/folders`, id: 'action-create-folder', action: () => navigate(`${prefix}/folders?create=true`.replace(/\/+/g, '/') || '/folders?create=true') },
    { type: 'action', title: t('bookmarks.import'), path: `${prefix}/bookmarks`, id: 'action-import', action: () => navigate(`${prefix}/bookmarks?import=true`.replace(/\/+/g, '/') || '/bookmarks?import=true') },
    { type: 'action', title: t('bookmarks.export'), path: `${prefix}/bookmarks`, id: 'action-export', action: () => navigate(`${prefix}/bookmarks?export=true`.replace(/\/+/g, '/') || '/bookmarks?export=true') },
  ], [t, navigate, prefix]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openSearch();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openSearch]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([...navigationItems, ...actionItems]);
      return;
    }

    if (!open) {
      setResults([]);
      return;
    }

    const searchTimeout = setTimeout(async () => {
      setLoading(true);
      try {
        const searchLower = query.toLowerCase();
        try {
          const searchRes = await api.get('/bookmarks/search', { params: { q: query } });
          const searchResults: SearchResult[] = searchRes.data.map((item: { id: string; type: string; title: string; url?: string; icon?: string | null }) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            url: item.url,
            icon: item.icon,
          }));
          setResults([
            ...navigationItems.filter((n) => n.title.toLowerCase().includes(searchLower)),
            ...actionItems.filter((a) => a.title.toLowerCase().includes(searchLower)),
            ...searchResults,
          ]);
        } catch {
          const [bookmarksRes, foldersRes, tagsRes] = await Promise.all([
            api.get('/bookmarks', { params: { limit: 100 } }),
            api.get('/folders'),
            api.get('/tags'),
          ]);
          const bookmarksPayload = bookmarksRes.data;
          const bookmarksItems = bookmarksPayload?.items ?? bookmarksPayload ?? [];

          const bookmarkResults: SearchResult[] = (Array.isArray(bookmarksItems) ? bookmarksItems : [])
            .filter((b: { title?: string; url?: string; slug?: string }) =>
              (b.title?.toLowerCase().includes(searchLower)) ||
              (b.url?.toLowerCase().includes(searchLower)) ||
              (b.slug?.toLowerCase().includes(searchLower))
            )
            .slice(0, 5)
            .map((b: { id: string; title: string; url?: string }) => ({
              id: b.id,
              type: 'bookmark' as const,
              title: b.title,
              url: b.url,
            }));

          const folderResults: SearchResult[] = foldersRes.data
            .filter((f: { name: string }) => f.name.toLowerCase().includes(searchLower))
            .slice(0, 3)
            .map((f: { id: string; name: string; icon?: string | null }) => ({
              id: f.id,
              type: 'folder' as const,
              title: f.name,
              icon: f.icon,
            }));

          const tagResults: SearchResult[] = tagsRes.data
            .filter((tag: { name: string }) => tag.name.toLowerCase().includes(searchLower))
            .slice(0, 3)
            .map((tag: { id: string; name: string }) => ({
              id: tag.id,
              type: 'tag' as const,
              title: tag.name,
            }));

          setResults([
            ...navigationItems.filter((n) => n.title.toLowerCase().includes(searchLower)),
            ...actionItems.filter((a) => a.title.toLowerCase().includes(searchLower)),
            ...bookmarkResults,
            ...folderResults,
            ...tagResults,
          ]);
        }
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(searchTimeout);
  }, [query, open, navigationItems, actionItems]);

  function handleResultClick(result: SearchResult) {
    setOpen(false);
    setQuery('');

    if (result.type === 'navigation' && result.path) {
      navigate(result.path);
    } else if (result.type === 'action' && result.action) {
      result.action();
    } else if (result.type === 'bookmark' && result.url) {
      api.post(`/bookmarks/${result.id}/track-access`).catch(() => {});
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } else if (result.type === 'folder') {
      navigate(`${prefix}/bookmarks?folder_id=${result.id}`.replace(/\/+/g, '/') || `/bookmarks?folder_id=${result.id}`);
    } else if (result.type === 'tag') {
      navigate(`${prefix}/bookmarks?tag_id=${result.id}`.replace(/\/+/g, '/') || `/bookmarks?tag_id=${result.id}`);
    }
  }

  function getResultIcon(result: SearchResult) {
    switch (result.type) {
      case 'bookmark':
        return <Bookmark className="h-4 w-4" />;
      case 'folder':
        return <Folder className="h-4 w-4" />;
      case 'tag':
        return <Tag className="h-4 w-4" />;
      case 'navigation':
        return <ArrowRight className="h-4 w-4" />;
      case 'action':
        return <Plus className="h-4 w-4" />;
    }
  }

  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          placeholder={t('dashboard.searchPlaceholder')}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>
            {loading ? t('common.loading') : t('common.noResults')}
          </CommandEmpty>
          {!query.trim() ? (
            <>
              <CommandGroup heading={t('common.navigation')}>
                {navigationItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => handleResultClick(item)}
                  >
                    {getResultIcon(item)}
                    <span>{item.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={t('common.quickActions')}>
                {actionItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => handleResultClick(item)}
                  >
                    {getResultIcon(item)}
                    <span>{item.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : (
            results.map((result) => (
              <CommandItem
                key={`${result.type}-${result.id}`}
                value={`${result.type}-${result.id}-${result.title}`}
                onSelect={() => handleResultClick(result)}
              >
                {getResultIcon(result)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{result.title}</span>
                    {result.type === 'bookmark' && (
                      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </div>
                  {result.url && (
                    <div className="text-xs text-muted-foreground truncate mt-0.5">{result.url}</div>
                  )}
                </div>
              </CommandItem>
            ))
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
