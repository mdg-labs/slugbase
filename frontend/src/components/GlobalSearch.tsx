import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
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
  absoluteUrlForGoSlug,
  parseGoCommandQuery,
  parseGoCommandSlugPrefix,
} from '../utils/goRedirectUrl';
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
  slug?: string;
  icon?: string | null;
  action?: () => void;
  path?: string;
}

function resultValue(r: SearchResult): string {
  return `${r.type}-${r.id}`;
}

export default function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathPrefixForLinks, apiBaseUrl } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { user } = useAuth();
  const { open, setOpen, openSearch } = useSearchCommand();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [cmdValue, setCmdValue] = useState('');

  const showAdmin = canAccessWorkspaceAdmin(user);

  const trimmedQuery = query.trim();
  const goSlugPrefix = useMemo(
    () => parseGoCommandSlugPrefix(trimmedQuery),
    [trimmedQuery]
  );
  const isGoCommandMode = goSlugPrefix !== null;

  const navigationItems: SearchResult[] = useMemo(
    () => [
      {
        type: 'navigation',
        title: t('bookmarks.title'),
        path: `${prefix}/bookmarks`.replace(/\/+/g, '/') || '/bookmarks',
        id: 'nav-bookmarks',
      },
      {
        type: 'navigation',
        title: t('folders.title'),
        path: `${prefix}/folders`.replace(/\/+/g, '/') || '/folders',
        id: 'nav-folders',
      },
      {
        type: 'navigation',
        title: t('tags.title'),
        path: `${prefix}/tags`.replace(/\/+/g, '/') || '/tags',
        id: 'nav-tags',
      },
      ...(showAdmin
        ? [
            {
              type: 'navigation' as const,
              title: t('admin.title'),
              path: `${prefix}/admin`.replace(/\/+/g, '/') || '/admin',
              id: 'nav-admin',
            },
          ]
        : []),
    ],
    [showAdmin, t, prefix]
  );

  const actionItems: SearchResult[] = useMemo(
    () => [
      {
        type: 'action',
        title: t('bookmarks.create'),
        path: `${prefix}/bookmarks`,
        id: 'action-create-bookmark',
        action: () =>
          navigate(`${prefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true'),
      },
      {
        type: 'action',
        title: t('folders.create'),
        path: `${prefix}/folders`,
        id: 'action-create-folder',
        action: () =>
          navigate(`${prefix}/folders?create=true`.replace(/\/+/g, '/') || '/folders?create=true'),
      },
      {
        type: 'action',
        title: t('bookmarks.import'),
        path: `${prefix}/bookmarks`,
        id: 'action-import',
        action: () =>
          navigate(`${prefix}/bookmarks?import=true`.replace(/\/+/g, '/') || '/bookmarks?import=true'),
      },
      {
        type: 'action',
        title: t('bookmarks.export'),
        path: `${prefix}/bookmarks`,
        id: 'action-export',
        action: () =>
          navigate(`${prefix}/bookmarks?export=true`.replace(/\/+/g, '/') || '/bookmarks?export=true'),
      },
    ],
    [t, navigate, prefix]
  );

  const flatSelectable = useMemo((): SearchResult[] => {
    if (!query.trim()) {
      return [...navigationItems, ...actionItems];
    }
    if (isGoCommandMode) {
      return results;
    }
    return results;
  }, [query, navigationItems, actionItems, isGoCommandMode, results]);

  useEffect(() => {
    if (!open) {
      setCmdValue('');
      return;
    }
    if (!flatSelectable.length) return;
    setCmdValue((prev) => {
      if (flatSelectable.some((r) => resultValue(r) === prev)) return prev;
      return resultValue(flatSelectable[0]);
    });
  }, [open, flatSelectable]);

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

    if (goSlugPrefix !== null) {
      const goTimeout = setTimeout(async () => {
        setLoading(true);
        try {
          const bookmarksRes = await api.get('/bookmarks', { params: { limit: 500 } });
          const bookmarksPayload = bookmarksRes.data;
          const bookmarksItems = bookmarksPayload?.items ?? bookmarksPayload ?? [];
          const list = Array.isArray(bookmarksItems) ? bookmarksItems : [];
          const prefixLower = goSlugPrefix.toLowerCase();
          const filtered = list
            .filter((b: { slug?: string | null }) => {
              const slug = b.slug;
              if (slug == null || String(slug).trim() === '') return false;
              if (!prefixLower) return true;
              return String(slug).toLowerCase().startsWith(prefixLower);
            })
            .sort((a: { slug?: string }, b: { slug?: string }) =>
              String(a.slug || '').localeCompare(String(b.slug || ''), undefined, {
                sensitivity: 'base',
              })
            )
            .slice(0, 25);
          const goResults: SearchResult[] = filtered.map(
            (b: { id: string; title: string; url?: string; slug?: string | null }) => ({
              id: b.id,
              type: 'bookmark' as const,
              title: b.title,
              url: b.url,
              slug: b.slug ?? undefined,
            })
          );
          setResults(goResults);
        } catch (error) {
          console.error('Go command bookmark load failed:', error);
          setResults([]);
        } finally {
          setLoading(false);
        }
      }, 300);
      return () => clearTimeout(goTimeout);
    }

    const searchTimeout = setTimeout(async () => {
      setLoading(true);
      try {
        const searchLower = query.toLowerCase();
        try {
          const searchRes = await api.get('/bookmarks/search', { params: { q: query } });
          const searchResults: SearchResult[] = searchRes.data.map(
            (item: { id: string; type: string; title: string; url?: string; icon?: string | null }) => ({
              id: item.id,
              type: item.type as SearchResult['type'],
              title: item.title,
              url: item.url,
              icon: item.icon,
            })
          );
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
            .filter(
              (b: { title?: string; url?: string; slug?: string }) =>
                b.title?.toLowerCase().includes(searchLower) ||
                b.url?.toLowerCase().includes(searchLower) ||
                b.slug?.toLowerCase().includes(searchLower)
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
  }, [query, open, navigationItems, actionItems, goSlugPrefix]);

  const handleResultClick = useCallback(
    (result: SearchResult, opts?: { newTab?: boolean }) => {
      const newTab = opts?.newTab ?? false;
      setOpen(false);
      setQuery('');

      if (result.type === 'navigation' && result.path) {
        if (newTab) window.open(result.path, '_blank', 'noopener,noreferrer');
        else navigate(result.path);
      } else if (result.type === 'action' && result.action) {
        result.action();
      } else if (result.type === 'bookmark' && result.url) {
        api.post(`/bookmarks/${result.id}/track-access`).catch(() => {});
        window.open(result.url, '_blank', 'noopener,noreferrer');
      } else if (result.type === 'folder') {
        const p =
          `${prefix}/bookmarks?folder_id=${result.id}`.replace(/\/+/g, '/') ||
          `/bookmarks?folder_id=${result.id}`;
        if (newTab) window.open(p, '_blank', 'noopener,noreferrer');
        else navigate(p);
      } else if (result.type === 'tag') {
        const p =
          `${prefix}/bookmarks?tag_id=${result.id}`.replace(/\/+/g, '/') || `/bookmarks?tag_id=${result.id}`;
        if (newTab) window.open(p, '_blank', 'noopener,noreferrer');
        else navigate(p);
      }
    },
    [navigate, prefix, setOpen]
  );

  const resolveResultFromValue = useCallback(
    (value: string): SearchResult | undefined => {
      return flatSelectable.find((r) => resultValue(r) === value);
    },
    [flatSelectable]
  );

  const handleCommandKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
      const r = resolveResultFromValue(cmdValue);
      if (!r) return;
      e.preventDefault();
      e.stopPropagation();
      handleResultClick(r, { newTab: true });
    },
    [cmdValue, resolveResultFromValue, handleResultClick]
  );

  function handleCommandInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const slug = parseGoCommandQuery(query.trim());
    if (!slug) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    setQuery('');
    const url = absoluteUrlForGoSlug(slug, { apiBaseUrl });
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function getResultIcon(result: SearchResult) {
    const ic = 'h-[15px] w-[15px] shrink-0';
    switch (result.type) {
      case 'bookmark':
        return <Bookmark className={ic} strokeWidth={1.75} />;
      case 'folder':
        return <Folder className={ic} strokeWidth={1.75} />;
      case 'tag':
        return <Tag className={ic} strokeWidth={1.75} />;
      case 'navigation':
        return <ArrowRight className={ic} strokeWidth={1.75} />;
      case 'action':
        return <Plus className={ic} strokeWidth={1.75} />;
    }
  }

  function groupHeading(type: SearchResult['type']): string {
    switch (type) {
      case 'navigation':
        return t('common.navigation');
      case 'action':
        return t('common.quickActions');
      case 'bookmark':
        return t('bookmarks.title');
      case 'folder':
        return t('folders.title');
      case 'tag':
        return t('tags.title');
    }
  }

  const searchGrouped = useMemo(() => {
    const order: SearchResult['type'][] = ['navigation', 'action', 'bookmark', 'folder', 'tag'];
    const map = new Map<SearchResult['type'], SearchResult[]>();
    for (const r of results) {
      const list = map.get(r.type) ?? [];
      list.push(r);
      map.set(r.type, list);
    }
    return order.map((type) => ({ type, items: map.get(type) ?? [] })).filter((g) => g.items.length > 0);
  }, [results]);

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setQuery('');
        }}
        shouldFilter={false}
        commandValue={cmdValue}
        onCommandValueChange={setCmdValue}
        onCommandKeyDown={handleCommandKeyDown}
      >
        <CommandInput
          placeholder={t('dashboard.searchPlaceholder')}
          value={query}
          onValueChange={setQuery}
          onKeyDown={handleCommandInputKeyDown}
        />
        <CommandList>
          <CommandEmpty>{loading ? t('common.loading') : t('common.noResults')}</CommandEmpty>
          {!query.trim() ? (
            <>
              <CommandGroup heading={t('common.navigation')}>
                {navigationItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={resultValue(item)}
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
                    value={resultValue(item)}
                    onSelect={() => handleResultClick(item)}
                  >
                    {getResultIcon(item)}
                    <span>{item.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : isGoCommandMode ? (
            <CommandGroup heading={t('dashboard.goCommandMatches')}>
              {results.map((result) => (
                <CommandItem
                  key={`${result.type}-${result.id}`}
                  value={resultValue(result)}
                  onSelect={() => handleResultClick(result)}
                >
                  {getResultIcon(result)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{result.title}</span>
                      {result.type === 'bookmark' && (
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden strokeWidth={1.75} />
                      )}
                    </div>
                    {result.slug ? (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3">go/{result.slug}</div>
                    ) : (
                      result.url && (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3">{result.url}</div>
                      )
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            searchGrouped.map((group, gi) => (
              <div key={group.type}>
                {gi > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={groupHeading(group.type)}>
                  {group.items.map((result) => (
                    <CommandItem
                      key={`${result.type}-${result.id}`}
                      value={resultValue(result)}
                      onSelect={() => handleResultClick(result)}
                    >
                      {getResultIcon(result)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{result.title}</span>
                          {result.type === 'bookmark' && (
                            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden strokeWidth={1.75} />
                          )}
                        </div>
                        {result.url && (
                          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3">{result.url}</div>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </div>
            ))
          )}
        </CommandList>
        <div className="palette-foot flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-fg-3">
          <span className="inline-flex items-center gap-1">
            <span className="rounded border border-border bg-bg-3 px-1 py-0.5 font-mono text-[10px] leading-none">↵</span>
            open
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="rounded border border-border bg-bg-3 px-1 py-0.5 font-mono text-[10px] leading-none">↑</span>
            <span className="rounded border border-border bg-bg-3 px-1 py-0.5 font-mono text-[10px] leading-none">↓</span>
            navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="rounded border border-border bg-bg-3 px-1 py-0.5 font-mono text-[10px] leading-none">⌘</span>
            <span className="rounded border border-border bg-bg-3 px-1 py-0.5 font-mono text-[10px] leading-none">↵</span>
            new tab
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <span className="rounded border border-border bg-bg-3 px-1 py-0.5 font-mono text-[10px] leading-none">Esc</span>
            close
          </span>
        </div>
      </CommandDialog>
    </>
  );
}
