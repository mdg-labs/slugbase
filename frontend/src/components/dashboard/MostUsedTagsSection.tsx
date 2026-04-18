import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { Card } from '../ui/card';

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
 * Most used tags — `tag-wall` inside elevated card (mockup dashboard).
 */
export function MostUsedTagsSection({ tags, pathPrefix, t }: MostUsedTagsSectionProps) {
  const prefix = pathPrefix.replace(/\/+/g, '/') || '';

  if (tags.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--fg-3)]">
        <TrendingUp className="h-3.5 w-3.5 text-[var(--fg-2)]" strokeWidth={1.75} aria-hidden />
        {t('dashboard.topTags')}
      </div>
      <Card className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
        <div className="tag-wall flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Link
              key={tag.id}
              to={`${prefix}/bookmarks?tag_id=${tag.id}`}
              className="tag inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-2 py-1 text-[12.5px] transition-colors hover:border-[var(--accent-ring)] hover:bg-[var(--accent-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
              title={t('dashboard.filterByTagHint')}
            >
              <span className="dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
              <span className="text-[var(--fg-1)]">{tag.name}</span>
              <span className="font-mono text-[10px] text-[var(--fg-3)]">{tag.bookmark_count}</span>
            </Link>
          ))}
        </div>
      </Card>
    </section>
  );
}
