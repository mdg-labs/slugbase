import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { Badge } from '../ui/badge';

export interface MostUsedTagsSectionTag {
  id: string;
  name: string;
  bookmark_count: number;
}

export interface MostUsedTagsSectionProps {
  tags: MostUsedTagsSectionTag[];
  pathPrefix: string;
  t: (key: string) => string;
}

/**
 * Most used tags section: title, clickable tag chips linking to bookmarks filtered by tag.
 * Improved spacing and visual rhythm.
 */
export function MostUsedTagsSection({ tags, pathPrefix, t }: MostUsedTagsSectionProps) {
  const prefix = pathPrefix.replace(/\/+/g, '/') || '';

  if (tags.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <TrendingUp className="h-4 w-4" />
        {t('dashboard.topTags')}
      </h2>
      <div className="flex flex-wrap gap-2.5">
        {tags.map((tag) => (
          <Link
            key={tag.id}
            to={`${prefix}/bookmarks?tag_id=${tag.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:border-primary/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            title={t('dashboard.filterByTagHint')}
          >
            <span>{tag.name}</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
              {tag.bookmark_count}
            </Badge>
          </Link>
        ))}
      </div>
    </section>
  );
}
