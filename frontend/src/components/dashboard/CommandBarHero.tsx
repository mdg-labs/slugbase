import { Search } from 'lucide-react';
import { useSearchCommand } from '../../contexts/SearchCommandContext';

export interface CommandBarHeroProps {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  shortcutHint: string;
  /** When false, only the search bar is shown (title lives in `PageHeader` above). */
  showTitleBlock?: boolean;
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
      <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-[var(--fg-0)]">{title}</h1>
    );
  }
  const before = title.slice(0, idx);
  const after = title.slice(idx + 2);
  return (
    <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-[var(--fg-0)]">
      {before}
      <span className="bg-gradient-to-r from-[var(--accent)] to-[#5764f1] bg-clip-text text-transparent">Go</span>
      {after}
    </h1>
  );
}

/**
 * Centered hero + glass command bar; opens global search (⌘K / Ctrl+K) on click.
 */
export function CommandBarHero({
  title,
  subtitle,
  searchPlaceholder,
  shortcutHint,
  showTitleBlock = true,
}: CommandBarHeroProps) {
  const { openSearch } = useSearchCommand();
  const mod = isApplePlatform() ? '⌘' : 'Ctrl';

  return (
    <section className="relative mb-2 flex flex-col items-center gap-5 py-1 sm:mb-4">
      {showTitleBlock ? (
        <div className="mx-auto max-w-2xl space-y-2 text-center">
          <HeroTitle title={title} />
          <p className="text-sm font-medium text-[var(--fg-2)] sm:text-[13px]">{subtitle}</p>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => openSearch()}
        className="group w-full max-w-2xl rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-1)] px-5 py-4 flex items-center gap-3 text-left shadow-[var(--shadow-sm)] transition-all duration-300 hover:border-[var(--border-strong)] hover:bg-[var(--bg-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)]"
        aria-label={shortcutHint}
      >
        <Search className="h-4 w-4 shrink-0 text-[var(--fg-3)] transition-colors group-hover:text-[var(--accent-hi)]" aria-hidden />
        <span className="flex-1 truncate text-[13px] font-medium text-[var(--fg-2)]">{searchPlaceholder}</span>
        <span className="hidden items-center gap-1.5 sm:inline-flex shrink-0" aria-hidden>
          <kbd className="pointer-events-none rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--fg-3)]">
            {mod}
          </kbd>
          <kbd className="pointer-events-none rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--fg-3)]">
            K
          </kbd>
        </span>
      </button>
    </section>
  );
}
