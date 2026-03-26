/**
 * CollectionToolbar — Reusable toolbar for collection pages (Bookmarks, Folders, Tags).
 *
 * Row 1: title, count?, subtitle?, tabs?, createButton? (gradient primary CTA)
 * Row 2: filterChips?
 * Row 3: search?, folderFilter?, tagFilter?, sort? — primary filters; secondary
 *   (per page, pinned, import/export, bulk select) live in the "more" menu.
 */

import { useState } from 'react';
import { Plus, CheckSquare, Download, Upload, Pin, Search, MoreHorizontal } from 'lucide-react';
import { PageHeader } from '../PageHeader';
import { ScopeSegmentedControl } from '../ScopeSegmentedControl';
import { FilterChips, type FilterChipItem } from '../FilterChips';
import Button from '../ui/Button';
import Select from '../ui/Select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from '../ui/dropdown-menu';

export interface CollectionToolbarProps {
  /** Row 1 */
  title: string;
  count?: number;
  subtitle?: string;
  tabs?: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
    ariaLabel?: string;
  };
  createButton?: { label: string; onClick: () => void };
  /** Row 2 */
  filterChips?: {
    chips: FilterChipItem[];
    onRemove: (key: string) => void;
    onClearAll: () => void;
    clearAllLabel: string;
    clearAllAriaLabel: string;
  };
  /** Row 3 — primary filters */
  search?: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
    placeholder?: string;
    ariaLabel?: string;
  };
  folderFilter?: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string; icon?: string | null }[];
    placeholder?: string;
  };
  tagFilter?: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
    placeholder?: string;
  };
  sort?: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
    className?: string;
  };
  /** Secondary — shown inside "more" menu */
  perPage?: {
    value: number;
    onChange: (value: number) => void;
    options: number[];
    label?: string;
  };
  pinnedToggle?: { active: boolean; onClick: () => void; label: string };
  onImport?: () => void;
  importLabel?: string;
  onExport?: () => void;
  exportLabel?: string;
  bulkSelect?: { onClick: () => void; label: string; disabled?: boolean };
  /** "More" menu trigger label (i18n) */
  moreMenuLabel?: string;
  /** Optional wrapper className */
  className?: string;
}

const STICKY_CLASS =
  'sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background/95 backdrop-blur-sm';

export function CollectionToolbar({
  title,
  count,
  subtitle,
  tabs,
  createButton,
  filterChips,
  search,
  folderFilter,
  tagFilter,
  sort,
  perPage,
  pinnedToggle,
  onImport,
  importLabel = 'Import',
  onExport,
  exportLabel = 'Export',
  bulkSelect,
  moreMenuLabel = 'More',
  className,
}: CollectionToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const displayTitle = count !== undefined ? `${title} (${count})` : title;

  const hasSecondary =
    perPage ||
    pinnedToggle ||
    onImport ||
    onExport ||
    (bulkSelect && !bulkSelect.disabled);

  const hasToolbarRow = search || folderFilter || tagFilter || sort || hasSecondary;

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {tabs && (
        <ScopeSegmentedControl
          value={tabs.value}
          onChange={tabs.onChange}
          options={tabs.options}
          ariaLabel={tabs.ariaLabel}
        />
      )}
      {createButton && (
        <Button
          onClick={createButton.onClick}
          icon={Plus}
          variant="primary"
          className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
        >
          {createButton.label}
        </Button>
      )}
    </div>
  );

  return (
    <div className={className ? `${STICKY_CLASS} ${className}` : STICKY_CLASS}>
      <PageHeader
        className="pt-4"
        title={displayTitle}
        subtitle={subtitle}
        actions={tabs || createButton ? headerActions : undefined}
      />

      {filterChips && filterChips.chips.length > 0 && (
        <FilterChips
          chips={filterChips.chips}
          onRemove={filterChips.onRemove}
          onClearAll={filterChips.onClearAll}
          clearAllLabel={filterChips.clearAllLabel}
          clearAllAriaLabel={filterChips.clearAllAriaLabel}
        />
      )}

      {hasToolbarRow && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ghost bg-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[200px]">
            {search && (
              <div className="flex items-center gap-2 min-w-[200px] flex-1 rounded-lg border border-ghost bg-surface-highest px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  type="search"
                  value={search.value}
                  onChange={(e) => search.onChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      search.onSubmit((e.target as HTMLInputElement).value.trim());
                    }
                  }}
                  placeholder={search.placeholder}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  aria-label={search.ariaLabel ?? search.placeholder}
                />
              </div>
            )}
            {folderFilter && (
              <div className="min-w-[180px] flex-1">
                <Select
                  value={folderFilter.value}
                  onChange={folderFilter.onChange}
                  options={folderFilter.options}
                  placeholder={folderFilter.placeholder}
                />
              </div>
            )}
            {tagFilter && (
              <div className="min-w-[180px] flex-1">
                <Select
                  value={tagFilter.value}
                  onChange={tagFilter.onChange}
                  options={tagFilter.options}
                  placeholder={tagFilter.placeholder}
                />
              </div>
            )}
            {sort && (
              <div className="flex items-center gap-2">
                <Select
                  value={sort.value}
                  onChange={sort.onChange}
                  options={sort.options}
                  className={sort.className ?? 'min-w-[160px]'}
                />
              </div>
            )}
          </div>

          {hasSecondary && (
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" icon={MoreHorizontal} className="shrink-0 border-ghost bg-surface-high">
                  {moreMenuLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                {perPage && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{perPage.label ?? 'Per page'}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={String(perPage.value)}
                        onValueChange={(v) => {
                          perPage.onChange(Number(v));
                          setMoreOpen(false);
                        }}
                      >
                        {perPage.options.map((n) => (
                          <DropdownMenuRadioItem key={n} value={String(n)}>
                            {n}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {pinnedToggle && (
                  <DropdownMenuCheckboxItem
                    checked={pinnedToggle.active}
                    onCheckedChange={() => pinnedToggle.onClick()}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <Pin className="h-4 w-4" />
                    {pinnedToggle.label}
                  </DropdownMenuCheckboxItem>
                )}
                {(onImport || onExport) && <DropdownMenuSeparator />}
                {onImport && (
                  <DropdownMenuItem
                    onClick={() => {
                      onImport();
                      setMoreOpen(false);
                    }}
                  >
                    <Upload className="h-4 w-4" />
                    {importLabel}
                  </DropdownMenuItem>
                )}
                {onExport && (
                  <DropdownMenuItem
                    onClick={() => {
                      onExport();
                      setMoreOpen(false);
                    }}
                  >
                    <Download className="h-4 w-4" />
                    {exportLabel}
                  </DropdownMenuItem>
                )}
                {bulkSelect && !bulkSelect.disabled && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        bulkSelect.onClick();
                        setMoreOpen(false);
                      }}
                    >
                      <CheckSquare className="h-4 w-4" />
                      {bulkSelect.label}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}
