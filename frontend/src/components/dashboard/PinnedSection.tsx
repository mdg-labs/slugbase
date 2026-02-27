import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Bookmark } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { EmptyState } from '../EmptyState';
import Button from '../ui/Button';
import BookmarkCard from '../bookmarks/BookmarkCard';

export interface PinnedSectionBookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
}

function toBookmarkCardItem(
  b: PinnedSectionBookmark,
  pinned: boolean
): Parameters<typeof BookmarkCard>[0]['bookmark'] {
  return {
    id: b.id,
    title: b.title,
    url: b.url,
    slug: b.slug || '',
    forwarding_enabled: !!b.slug,
    folders: [],
    tags: [],
    shared_teams: [],
    shared_users: [],
    bookmark_type: 'own',
    pinned,
    access_count: undefined,
    last_accessed_at: null,
  };
}

export interface PinnedSectionProps {
  items: PinnedSectionBookmark[];
  pathPrefix: string;
  maxItems?: number;
  t: (key: string) => string;
  onOpen: (id: string, url: string) => void;
  onCopyUrl: (url: string) => void;
}

/**
 * Pinned bookmarks section: title, "View all" link, grid (limited to maxItems), empty state.
 */
export function PinnedSection({
  items,
  pathPrefix,
  maxItems = 6,
  t,
  onOpen,
  onCopyUrl,
}: PinnedSectionProps) {
  const navigate = useNavigate();
  const prefix = pathPrefix.replace(/\/+/g, '/') || '';
  const displayItems = items.slice(0, maxItems);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.pinned')}
        </h2>
        <Link
          to={prefix + '/bookmarks?pinned=true'}
          className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
        >
          {t('dashboard.viewAll')}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      {displayItems.length > 0 ? (
        <div className="grid gap-3 items-stretch [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {displayItems.map((b) => (
            <BookmarkCard
              key={b.id}
              bookmark={toBookmarkCardItem(b, true)}
              compact={false}
              selected={false}
              onSelect={() => {}}
              onEdit={() => navigate(prefix + '/bookmarks')}
              onDelete={() => {}}
              onCopyUrl={() => onCopyUrl(b.url)}
              onOpen={() => onOpen(b.id, b.url)}
              bulkMode={false}
              t={t}
            />
          ))}
        </div>
      ) : (
        <Card className="border border-border bg-card shadow-sm">
          <CardContent className="p-6">
            <EmptyState
              icon={Bookmark}
              title={t('dashboard.noPinnedBookmarks')}
              description={t('dashboard.pinFromBookmarks')}
              action={
                <Link to={prefix + '/bookmarks'}>
                  <Button variant="secondary">{t('dashboard.pinFromBookmarksLink')}</Button>
                </Link>
              }
            />
          </CardContent>
        </Card>
      )}
    </section>
  );
}
