import { Search } from 'lucide-react';
import { useSearchCommand } from '../../contexts/SearchCommandContext';

export interface CommandBarHeroProps {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  shortcutHint: string;
}

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') || /Mac OS/.test(navigator.userAgent);
}

/**
 * Renders hero title with gradient emphasis on "Go" when present (matches Stitch / EN).
 */
function HeroTitle({ title }: { title: string }) {
  const idx = title.indexOf('Go');
  if (idx === -1) {
    return (
      <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-foreground">{title}</h1>
    );
  }
  const before = title.slice(0, idx);
  const after = title.slice(idx + 2);
  return (
    <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-foreground">
      {before}
      <span className="bg-gradient-to-r from-primary to-[#5764f1] bg-clip-text text-transparent">Go</span>
      {after}
    </h1>
  );
}

/**
 * Centered hero + glass command bar; opens global search (⌘K / Ctrl+K) on click.
 */
export function CommandBarHero({ title, subtitle, searchPlaceholder, shortcutHint }: CommandBarHeroProps) {
  const { openSearch } = useSearchCommand();
  const mod = isApplePlatform() ? '⌘' : 'Ctrl';

  return (
    <section className="relative mb-4 flex flex-col items-center gap-6 py-2 sm:mb-6">
      <div className="mx-auto max-w-2xl space-y-3 text-center">
        <HeroTitle title={title} />
        <p className="text-sm font-medium text-muted-foreground sm:text-base">{subtitle}</p>
      </div>
      <button
        type="button"
        onClick={() => openSearch()}
        className="group w-full max-w-2xl rounded-full border border-primary/20 glass shadow-glow px-6 py-5 flex items-center gap-4 text-left transition-all duration-300 hover:border-primary/35 hover:bg-surface-high/85 focus:outline-none focus-visible:border-primary/40 focus-visible:ring-4 focus-visible:ring-primary/10"
        aria-label={shortcutHint}
      >
        <Search className="h-4 w-4 shrink-0 text-primary transition-colors group-hover:text-primary" aria-hidden />
        <span className="flex-1 truncate text-base font-medium text-muted-foreground">{searchPlaceholder}</span>
        <span className="hidden items-center gap-2 sm:inline-flex shrink-0" aria-hidden>
          <kbd className="pointer-events-none rounded-md border border-ghost bg-surface-highest px-2 py-1 font-mono text-[10px] font-bold text-muted-foreground shadow-sm">
            {mod}
          </kbd>
          <kbd className="pointer-events-none rounded-md border border-ghost bg-surface-highest px-2 py-1 font-mono text-[10px] font-bold text-muted-foreground shadow-sm">
            K
          </kbd>
        </span>
      </button>
    </section>
  );
}
