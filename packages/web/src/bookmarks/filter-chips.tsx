import { Button } from "@slugbase/ui";
import { StatusBadge, XIcon } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

export interface FilterChip {
  readonly id: string;
  readonly label: string;
  readonly onRemove: () => void;
}

/** The filters that narrow the list now, each with the button that takes it off (doc 03 section 3.1). */
export function FilterChips({ chips }: { readonly chips: readonly FilterChip[] }): ReactElement | null {
  const { t } = useTranslation();
  if (chips.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t("bookmarks.list.filters.active")} className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <li key={chip.id}>
          <StatusBadge className="h-6.5 gap-0.5 ps-2 pe-0.5 text-sm sm:h-5.5 sm:text-xs">
            <span className="truncate">{chip.label}</span>
            <Button aria-label={t("bookmarks.list.filters.remove", { label: chip.label })} onClick={chip.onRemove} size="icon-xs" type="button" variant="ghost">
              <XIcon aria-hidden="true" />
            </Button>
          </StatusBadge>
        </li>
      ))}
    </ul>
  );
}
