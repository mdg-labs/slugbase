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
 * Centered hero + glass command bar; opens global search (⌘K / Ctrl+K) on click.
 */
export function CommandBarHero({ title, subtitle, searchPlaceholder, shortcutHint }: CommandBarHeroProps) {
  const { openSearch } = useSearchCommand();
  const mod = isApplePlatform() ? '⌘' : 'Ctrl';

  return (
    <section className="flex flex-col items-center text-center gap-4 py-2">
      <div className="space-y-2 max-w-2xl">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-foreground">{title}</h1>
        <p className="text-sm sm:text-base text-muted-foreground">{subtitle}</p>
      </div>
      <button
        type="button"
        onClick={() => openSearch()}
        className="group w-full max-w-xl rounded-xl border border-ghost glass shadow-glow px-4 py-3.5 flex items-center gap-3 text-left transition-colors hover:bg-surface-high/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={shortcutHint}
      >
        <Search className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
        <span className="flex-1 text-sm text-muted-foreground truncate">{searchPlaceholder}</span>
        <span className="hidden sm:inline-flex items-center gap-1 shrink-0" aria-hidden>
          <kbd className="pointer-events-none rounded-md border border-ghost bg-surface-low px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground shadow-sm">
            {mod}
          </kbd>
          <kbd className="pointer-events-none rounded-md border border-ghost bg-surface-low px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground shadow-sm">
            K
          </kbd>
        </span>
      </button>
    </section>
  );
}
