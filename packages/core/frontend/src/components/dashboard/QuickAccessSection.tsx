import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Bookmark, Plus } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { EmptyState } from '../EmptyState';
import Button from '../ui/Button';
import BookmarkCard from '../bookmarks/BookmarkCard';

export interface QuickAccessSectionBookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
}

function toBookmarkCardItem(
  b: QuickAccessSectionBookmark,
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

export interface QuickAccessSectionProps {
  items: QuickAccessSectionBookmark[];
  pathPrefix: string;
  maxItems?: number;
  /** Optional subtitle (e.g. "Most opened with shortcuts") */
  subtitle?: string;
  t: (key: string) => string;
  onOpen: (id: string, url: string) => void;
  onCopyUrl: (url: string) => void;
}

/**
 * Quick access section: title, optional subtitle, "View all" link, grid (limited to maxItems), empty state.
 */
export function QuickAccessSection({
  items,
  pathPrefix,
  maxItems = 6,
  subtitle,
  t,
  onOpen,
  onCopyUrl,
}: QuickAccessSectionProps) {
  const navigate = useNavigate();
  const prefix = pathPrefix.replace(/\/+/g, '/') || '';
  const displayItems = items.slice(0, maxItems);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {t('dashboard.quickAccess')}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <Link
          to={prefix + '/bookmarks'}
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
              bookmark={toBookmarkCardItem(b, false)}
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
              title={t('dashboard.noQuickAccessBookmarks')}
              description={t('dashboard.noQuickAccessBookmarksHint')}
              action={
                <Link to={`${prefix}/bookmarks?create=true`}>
                  <Button variant="primary" icon={Plus}>
                    {t('bookmarks.create')}
                  </Button>
                </Link>
              }
            />
          </CardContent>
        </Card>
      )}
    </section>
  );
}
