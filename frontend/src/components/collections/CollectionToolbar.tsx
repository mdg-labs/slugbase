/**
 * CollectionToolbar - Reusable toolbar for collection pages (Bookmarks, Folders, Tags).
 *
 * Row 1: title, count?, subtitle?, tabs?, createButton? (gradient primary CTA)
 * Row 2: filterChips?
 * Row 3: search?, folderFilter?, tagFilter?, sort? - primary filters; secondary
 *   (per page, pinned, import/export, bulk select) live in the "more" menu.
 */

import { useState, useRef } from 'react';
import { Plus, CheckSquare, Check, Download, Upload, Pin, Search, MoreHorizontal, LayoutGrid, List, Filter } from 'lucide-react';
import { PageHeader } from '../PageHeader';
import { ScopeSegmentedControl } from '../ScopeSegmentedControl';
import { FilterChips, type FilterChipItem } from '../FilterChips';
import Button from '../ui/Button';
import { SegmentedControl, SegmentedControlItem } from '../ui/SegmentedControl';
import Select from '../ui/Select';
import { Input } from '../ui/input';
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
  /** Row 3 - primary filters */
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
  /** Secondary - shown inside "more" menu */
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
  /** Bookmarks: cards vs table — inline `.seg` (Phase 4) */
  viewSegment?: {
    value: 'cards' | 'table';
    onChange: (value: 'cards' | 'table') => void;
    cardsLabel: string;
    tableLabel: string;
    ariaLabel?: string;
  };
  filtersButton?: { label: string; onClick: () => void };
  /** Legacy: cards vs table in More menu (omit when `viewSegment` is set) */
  viewDisplay?: {
    value: 'cards' | 'table';
    onChange: (value: 'cards' | 'table') => void;
    label: string;
    cardsLabel: string;
    tableLabel: string;
  };
  /** "More" menu trigger label (i18n) */
  moreMenuLabel?: string;
  /** Optional wrapper className */
  className?: string;
  /** Stitch-style display title (heavy weight) */
  titleClassName?: string;
  subtitleClassName?: string;
}

const STICKY_CLASS =
  'sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-[var(--bg-0)]/95 backdrop-blur-sm';

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
  viewSegment,
  viewDisplay,
  filtersButton,
  moreMenuLabel = 'More',
  className,
  titleClassName,
  subtitleClassName,
}: CollectionToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const displayTitle = count !== undefined ? `${title} (${count})` : title;

  const hasSecondary =
    perPage ||
    pinnedToggle ||
    onImport ||
    onExport ||
    (bulkSelect && !bulkSelect.disabled) ||
    (viewDisplay && !viewSegment);

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
      {viewSegment && (
        <SegmentedControl
          type="single"
          value={viewSegment.value}
          onValueChange={(v) => {
            if (v === 'cards' || v === 'table') viewSegment.onChange(v);
          }}
          aria-label={viewSegment.ariaLabel ?? 'View mode'}
          className="inline-flex"
        >
          <SegmentedControlItem value="cards" aria-label={viewSegment.cardsLabel}>
            <LayoutGrid className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            <span className="hidden md:inline">{viewSegment.cardsLabel}</span>
          </SegmentedControlItem>
          <SegmentedControlItem value="table" aria-label={viewSegment.tableLabel}>
            <List className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            <span className="hidden md:inline">{viewSegment.tableLabel}</span>
          </SegmentedControlItem>
        </SegmentedControl>
      )}
      {createButton && (
        <Button onClick={createButton.onClick} icon={Plus} variant="primary">
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
        titleClassName={titleClassName}
        subtitleClassName={subtitleClassName}
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[200px] flex-1 flex-wrap items-center gap-2">
            {search && (
              <Input
                ref={searchInputRef}
                id="collection-toolbar-search"
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    search.onSubmit((e.target as HTMLInputElement).value.trim());
                  }
                }}
                placeholder={search.placeholder}
                aria-label={search.ariaLabel ?? search.placeholder}
                leftSlot={<Search className="text-[var(--fg-3)]" aria-hidden />}
                className="min-h-9 min-w-[min(280px,100%)] flex-1 max-w-[400px]"
              />
            )}
            {filtersButton && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={Filter}
                className="shrink-0"
                onClick={() => {
                  filtersButton.onClick();
                  searchInputRef.current?.focus();
                }}
              >
                {filtersButton.label}
              </Button>
            )}
            {folderFilter && (
              <div className="min-w-[160px] max-w-[200px] flex-1 sm:max-w-[220px]">
                <Select
                  value={folderFilter.value}
                  onChange={folderFilter.onChange}
                  options={folderFilter.options}
                  placeholder={folderFilter.placeholder}
                />
              </div>
            )}
            {tagFilter && (
              <div className="min-w-[160px] max-w-[200px] flex-1 sm:max-w-[220px]">
                <Select
                  value={tagFilter.value}
                  onChange={tagFilter.onChange}
                  options={tagFilter.options}
                  placeholder={tagFilter.placeholder}
                />
              </div>
            )}
            {sort && (
              <div className="flex min-w-[140px] max-w-[180px] items-center gap-2 sm:max-w-[200px]">
                <Select
                  value={sort.value}
                  onChange={sort.onChange}
                  options={sort.options}
                  className={sort.className ?? 'w-full min-w-0'}
                />
              </div>
            )}
          </div>

          {hasSecondary && (
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" icon={MoreHorizontal} className="shrink-0">
                  {moreMenuLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                {viewDisplay && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{viewDisplay.label}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={viewDisplay.value}
                        onValueChange={(v) => {
                          if (v === 'cards' || v === 'table') {
                            viewDisplay.onChange(v);
                            setMoreOpen(false);
                          }
                        }}
                      >
                        <DropdownMenuRadioItem value="cards">{viewDisplay.cardsLabel}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="table">{viewDisplay.tableLabel}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
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
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      pinnedToggle.onClick();
                    }}
                  >
                    <Pin className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1">{pinnedToggle.label}</span>
                    {pinnedToggle.active ? (
                      <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </DropdownMenuItem>
                )}
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
