import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Search, X, Bookmark, Folder, Tag, ExternalLink, Plus, ArrowRight } from 'lucide-react';
import api from '../api/client';
import { appBasePath } from '../config/api';
import { isCloud } from '../config/mode';

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
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      // Escape to close
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        setQuery('');
        setResults([]);
        setSelectedIndex(0);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setQuery('');
        setResults([]);
        setSelectedIndex(0);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const showAdmin = user?.is_admin || (isCloud && (user?.org_role === 'owner' || user?.org_role === 'admin'));

  // Navigation and action items (always shown when no query)
  const navigationItems: SearchResult[] = [
    { type: 'navigation', title: t('bookmarks.title'), path: `${appBasePath}/bookmarks`, id: 'nav-bookmarks' },
    { type: 'navigation', title: t('folders.title'), path: `${appBasePath}/folders`, id: 'nav-folders' },
    { type: 'navigation', title: t('tags.title'), path: `${appBasePath}/tags`, id: 'nav-tags' },
    { type: 'navigation', title: t('shared.title'), path: `${appBasePath}/shared`, id: 'nav-shared' },
    ...(showAdmin ? [{ type: 'navigation' as const, title: t('admin.title'), path: `${appBasePath}/admin`, id: 'nav-admin' }] : []),
  ];

  const actionItems: SearchResult[] = [
    { type: 'action', title: t('bookmarks.create'), path: `${appBasePath}/bookmarks`, id: 'action-create-bookmark', action: () => navigate(`${appBasePath}/bookmarks?create=true`) },
    { type: 'action', title: t('folders.create'), path: `${appBasePath}/folders`, id: 'action-create-folder', action: () => navigate(`${appBasePath}/folders?create=true`) },
    { type: 'action', title: t('bookmarks.import'), path: `${appBasePath}/bookmarks`, id: 'action-import', action: () => navigate(`${appBasePath}/bookmarks?import=true`) },
    { type: 'action', title: t('bookmarks.export'), path: `${appBasePath}/bookmarks`, id: 'action-export', action: () => navigate(`${appBasePath}/bookmarks?export=true`) },
  ];

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        handleResultClick(results[selectedIndex]);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, results, selectedIndex]);

  useEffect(() => {
    // Scroll selected item into view
    if (resultsRef.current && selectedIndex >= 0) {
      const selectedElement = resultsRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (!query.trim()) {
      // Show navigation and actions when no query
      setResults([...navigationItems, ...actionItems]);
      setSelectedIndex(0);
      return;
    }

    if (!isOpen) {
      setResults([]);
      return;
    }

    const searchTimeout = setTimeout(async () => {
      setLoading(true);
      try {
        const searchLower = query.toLowerCase();
        
        // Use backend search endpoint if available, otherwise client-side
        try {
          const searchRes = await api.get('/bookmarks/search', { params: { q: query } });
          const searchResults: SearchResult[] = searchRes.data.map((item: any) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            url: item.url,
            icon: item.icon,
          }));
          setResults([...navigationItems.filter(n => 
            n.title.toLowerCase().includes(searchLower)
          ), ...actionItems.filter(a => 
            a.title.toLowerCase().includes(searchLower)
          ), ...searchResults]);
        } catch {
          // Fallback to client-side search
          const [bookmarksRes, foldersRes, tagsRes] = await Promise.all([
            api.get('/bookmarks'),
            api.get('/folders'),
            api.get('/tags'),
          ]);

          const bookmarkResults: SearchResult[] = bookmarksRes.data
            .filter((b: any) => 
              b.title.toLowerCase().includes(searchLower) ||
              b.url.toLowerCase().includes(searchLower) ||
              (b.slug && b.slug.toLowerCase().includes(searchLower))
            )
            .slice(0, 5)
            .map((b: any) => ({
              id: b.id,
              type: 'bookmark' as const,
              title: b.title,
              url: b.url,
            }));

          const folderResults: SearchResult[] = foldersRes.data
            .filter((f: any) => f.name.toLowerCase().includes(searchLower))
            .slice(0, 3)
            .map((f: any) => ({
              id: f.id,
              type: 'folder' as const,
              title: f.name,
              icon: f.icon,
            }));

          const tagResults: SearchResult[] = tagsRes.data
            .filter((t: any) => t.name.toLowerCase().includes(searchLower))
            .slice(0, 3)
            .map((t: any) => ({
              id: t.id,
              type: 'tag' as const,
              title: t.name,
            }));

          setResults([
            ...navigationItems.filter(n => n.title.toLowerCase().includes(searchLower)),
            ...actionItems.filter(a => a.title.toLowerCase().includes(searchLower)),
            ...bookmarkResults,
            ...folderResults,
            ...tagResults,
          ]);
        }
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setLoading(false);
        setSelectedIndex(0);
      }
    }, 300);

    return () => clearTimeout(searchTimeout);
  }, [query, isOpen]);

  function handleResultClick(result: SearchResult) {
    setIsOpen(false);
    setQuery('');
    setResults([]);
    setSelectedIndex(0);

    if (result.type === 'navigation' && result.path) {
      navigate(result.path);
    } else if (result.type === 'action' && result.action) {
      result.action();
    } else if (result.type === 'bookmark') {
      if (result.url) {
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }
    } else if (result.type === 'folder') {
      navigate(`${appBasePath}/bookmarks?folder_id=${result.id}`);
    } else if (result.type === 'tag') {
      navigate(`${appBasePath}/bookmarks?tag_id=${result.id}`);
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

  function getResultLabel(result: SearchResult) {
    switch (result.type) {
      case 'navigation':
        return t('common.goTo');
      case 'action':
        return t('common.actions');
      default:
        return '';
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="hidden md:flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors border border-gray-200 dark:border-gray-600"
      >
        <Search className="h-4 w-4" />
        <span>{t('common.search')}</span>
        <kbd className="hidden lg:inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">
          {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}K
        </kbd>
      </button>
    );
  }

  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;

  return (
    <div ref={containerRef} className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] px-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setIsOpen(false)} />
      <div className="relative w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <Search className="h-5 w-5 text-gray-400 dark:text-gray-500 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={t('common.searchPlaceholder')}
            className="flex-1 bg-transparent border-none outline-none text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 text-base"
            autoFocus
          />
          {query && (
            <button
              onClick={() => {
                setQuery('');
                setResults([...navigationItems, ...actionItems]);
                setSelectedIndex(0);
              }}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Results */}
        <div ref={resultsRef} className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
              {t('common.loading')}
            </div>
          ) : !hasQuery ? (
            <div className="py-2">
              {/* Navigation Section */}
              <div className="px-4 py-2">
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                  {t('common.navigation')}
                </div>
                {navigationItems.map((item, idx) => (
                  <button
                    key={item.id}
                    onClick={() => handleResultClick(item)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left ${
                      selectedIndex === idx ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <div className="flex-shrink-0 text-gray-400 dark:text-gray-500">
                      {getResultIcon(item)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {item.title}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Actions Section */}
              <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700">
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                  {t('common.quickActions')}
                </div>
                {actionItems.map((item, idx) => (
                  <button
                    key={item.id}
                    onClick={() => handleResultClick(item)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left ${
                      selectedIndex === navigationItems.length + idx ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <div className="flex-shrink-0 text-gray-400 dark:text-gray-500">
                      {getResultIcon(item)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {item.title}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : !hasResults ? (
            <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
              {t('common.noResults')}
            </div>
          ) : (
            <div className="py-2">
              {results.map((result, idx) => {
                const label = getResultLabel(result);
                return (
                  <button
                    key={`${result.type}-${result.id || idx}`}
                    onClick={() => handleResultClick(result)}
                    className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left ${
                      selectedIndex === idx ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <div className="flex-shrink-0 text-gray-400 dark:text-gray-500">
                      {getResultIcon(result)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {result.title}
                        </div>
                        {label && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {label}
                          </span>
                        )}
                      </div>
                      {result.url && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                          {result.url}
                        </div>
                      )}
                    </div>
                    {(result.type === 'bookmark' || result.type === 'navigation' || result.type === 'action') && (
                      <ExternalLink className="h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">↑↓</kbd>
                <span>Navigate</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">Enter</kbd>
                <span>Select</span>
              </span>
            </div>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">Esc</kbd>
              <span>Close</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
