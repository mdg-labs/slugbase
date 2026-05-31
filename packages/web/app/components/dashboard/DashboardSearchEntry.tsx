import { useTranslate } from "@tolgee/react";
import { Kbd } from "@slugbase/ui";

import { useCommandPalette } from "../command-palette/CommandPaletteProvider.js";

export function DashboardSearchEntry() {
  const { t } = useTranslate();
  const { setOpen } = useCommandPalette();

  return (
    <button
      type="button"
      className="mb-sp-7 flex w-full items-center gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-6 py-sp-5 text-left shadow-raised transition-colors duration-micro hover:border-[color:var(--border)] hover:bg-raised-2"
      onClick={() => {
        setOpen(true);
      }}
      data-testid="dashboard-search-entry"
    >
      <span className="text-fg-faint" aria-hidden>
        ⌕
      </span>
      <span className="flex-1 text-body text-fg-subtle">
        {t("dashboard.search_entry.placeholder")}
      </span>
      <span className="inline-flex items-center gap-sp-2 text-small text-fg-faint">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}
