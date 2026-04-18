import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search } from 'lucide-react';
import { SidebarTrigger, useSidebar } from './ui/sidebar';
import UserDropdown from './UserDropdown';
import { Breadcrumbs } from './Breadcrumbs';
import type { User } from '../contexts/AuthContext';
import { useSearchCommand } from '../contexts/SearchCommandContext';
import BookmarkModal from './modals/BookmarkModal';
import api from '../api/client';

interface TopBarProps {
  user: User | null;
}

export default function TopBar({ user }: TopBarProps) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const { openSearch } = useSearchCommand();
  const [bookmarkModalOpen, setBookmarkModalOpen] = useState(false);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!bookmarkModalOpen) return;
    let cancelled = false;
    Promise.all([api.get('/folders'), api.get('/tags')])
      .then(([foldersRes, tagsRes]) => {
        if (cancelled) return;
        setFolders(foldersRes.data ?? []);
        setTags(tagsRes.data ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookmarkModalOpen]);

  return (
    <>
      <header className="topbar sticky top-0 z-30 flex h-11 shrink-0 items-center gap-3 border-b border-border bg-bg-0 px-4 lg:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {isMobile && (
            <SidebarTrigger className="-ml-0.5 h-8 w-8 shrink-0 text-fg-2 hover:bg-bg-hover hover:text-fg-0" aria-label={t('common.expandSidebar')} />
          )}
          <Breadcrumbs className="crumbs min-w-0" />
        </div>
        <div className="actions flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => openSearch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:bg-bg-hover hover:text-fg-0"
          >
            <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span className="hidden sm:inline">{t('dashboard.searchPlaceholder')}</span>
            <span className="hidden rounded border border-border bg-bg-3 px-1.5 py-0.5 font-mono text-[10.5px] leading-snug text-fg-2 sm:inline">
              ⌘K
            </span>
          </button>
          <button
            type="button"
            onClick={() => setBookmarkModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:border-accent-hi hover:bg-accent-hi"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span className="hidden sm:inline">{t('bookmarks.create')}</span>
          </button>
          <UserDropdown user={user} />
        </div>
      </header>
      <BookmarkModal
        bookmark={null}
        folders={folders}
        tags={tags}
        isOpen={bookmarkModalOpen}
        onClose={() => setBookmarkModalOpen(false)}
        onTagCreated={(newTag) => setTags((prev) => [...prev, newTag])}
      />
    </>
  );
}
