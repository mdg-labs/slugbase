import { Bookmark, Folder, Tag } from 'lucide-react';
import { StatCard, type StatCardUsageProps } from '../StatCard';

export interface StatItem {
  label: string;
  value: number;
  href: string;
  secondaryLine?: string;
  /** Optional usage/limit for cloud; in core leave undefined */
  usage?: StatCardUsageProps;
}

export interface StatsCardsRowProps {
  bookmarks: StatItem;
  folders: StatItem;
  tags: StatItem;
  /** Optional; for denser layouts */
  dense?: boolean;
}

/**
 * Row of three stat cards: bookmarks, folders, tags.
 * Supports optional usage/limit/CTA per card for hosted cloud mode (pass usage in cloud only).
 */
export function StatsCardsRow({ bookmarks, folders, tags, dense }: StatsCardsRowProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-stretch">
      <StatCard
        label={bookmarks.label}
        value={bookmarks.value}
        icon={Bookmark}
        href={bookmarks.href}
        dense={dense}
        iconContainerClassName="bg-primary/20"
        iconColorClassName="text-primary"
        secondaryLine={bookmarks.secondaryLine}
        used={bookmarks.usage?.used}
        limit={bookmarks.usage?.limit}
        labelOverride={bookmarks.usage?.labelOverride}
        showProgress={bookmarks.usage?.showProgress}
        progressVariant={bookmarks.usage?.progressVariant}
        cta={bookmarks.usage?.cta}
      />
      <StatCard
        label={folders.label}
        value={folders.value}
        icon={Folder}
        href={folders.href}
        dense={dense}
        iconContainerClassName="bg-primary/20"
        iconColorClassName="text-primary"
        secondaryLine={folders.secondaryLine}
        used={folders.usage?.used}
        limit={folders.usage?.limit}
        labelOverride={folders.usage?.labelOverride}
        showProgress={folders.usage?.showProgress}
        progressVariant={folders.usage?.progressVariant}
        cta={folders.usage?.cta}
      />
      <StatCard
        label={tags.label}
        value={tags.value}
        icon={Tag}
        href={tags.href}
        dense={dense}
        iconContainerClassName="bg-primary/20"
        iconColorClassName="text-primary"
        secondaryLine={tags.secondaryLine}
        used={tags.usage?.used}
        limit={tags.usage?.limit}
        labelOverride={tags.usage?.labelOverride}
        showProgress={tags.usage?.showProgress}
        progressVariant={tags.usage?.progressVariant}
        cta={tags.usage?.cta}
      />
    </div>
  );
}
