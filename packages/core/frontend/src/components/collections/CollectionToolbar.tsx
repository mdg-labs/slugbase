/**
 * CollectionToolbar — Reusable toolbar for collection pages (Bookmarks, Folders, Tags).
 *
 * Props API summary:
 * - Row 1 (header): title, count?, subtitle?, tabs? (scope), createButton?
 * - Row 2: filterChips? (chips + onRemove, onClearAll, labels)
 * - Row 3 (toolbar card): search?, folderFilter?, tagFilter?, sort?, perPage?, viewMode?,
 *   pinnedToggle?, onImport?, onExport?, bulkSelect?
 * Only provided props are rendered. No collection-specific logic.
 */

import { Plus, LayoutGrid, List, CheckSquare, Download, Upload, Pin, Search } from 'lucide-react';
import { PageHeader } from '../PageHeader';
import { ScopeSegmentedControl } from '../ScopeSegmentedControl';
import { FilterChips, type FilterChipItem } from '../FilterChips';
import Button from '../ui/Button';
import Select from '../ui/Select';

export type ViewModeValue = 'card' | 'list';

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
  /** Row 3 — utility */
  perPage?: {
    value: number;
    onChange: (value: number) => void;
    options: number[];
    label?: string;
  };
  viewMode?: {
    value: ViewModeValue;
    onChange: (value: ViewModeValue) => void;
    cardLabel?: string;
    listLabel?: string;
  };
  pinnedToggle?: { active: boolean; onClick: () => void; label: string };
  onImport?: () => void;
  importLabel?: string;
  onExport?: () => void;
  exportLabel?: string;
  bulkSelect?: { onClick: () => void; label: string; disabled?: boolean };
  /** Optional wrapper className */
  className?: string;
}

const STICKY_CLASS =
  'sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background shadow-sm';

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
  viewMode,
  pinnedToggle,
  onImport,
  importLabel = 'Import',
  onExport,
  exportLabel = 'Export',
  bulkSelect,
  className,
}: CollectionToolbarProps) {
  const displayTitle = count !== undefined ? `${title} (${count})` : title;

  const hasToolbarRow =
    search ||
    folderFilter ||
    tagFilter ||
    sort ||
    perPage ||
    viewMode ||
    pinnedToggle ||
    onImport ||
    onExport ||
    (bulkSelect && !bulkSelect.disabled);

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
        <Button onClick={createButton.onClick} icon={Plus}>
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
        <div className="flex flex-wrap items-center gap-3 bg-card rounded-lg border border-border p-4 shadow-sm">
          {/* Primary filters — left */}
          <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[200px]">
            {search && (
              <div className="flex items-center gap-2 min-w-[200px] flex-1">
                <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden />
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
                  className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label={search.ariaLabel ?? search.placeholder}
                />
              </div>
            )}
            {folderFilter && (
              <div className="flex-1 min-w-[180px]">
                <Select
                  value={folderFilter.value}
                  onChange={folderFilter.onChange}
                  options={folderFilter.options}
                  placeholder={folderFilter.placeholder}
                />
              </div>
            )}
            {tagFilter && (
              <div className="flex-1 min-w-[180px]">
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

          {/* Utility — right, visually quieter */}
          <div className="flex flex-wrap items-center gap-3 border-l border-border pl-3 ml-auto">
            {pinnedToggle && (
              <Button
                variant={pinnedToggle.active ? 'secondary' : 'ghost'}
                size="sm"
                icon={Pin}
                onClick={pinnedToggle.onClick}
                title={pinnedToggle.label}
                aria-pressed={pinnedToggle.active}
              >
                <span className="hidden sm:inline">{pinnedToggle.label}</span>
              </Button>
            )}
            {onImport && (
              <Button variant="ghost" size="sm" icon={Upload} onClick={onImport} title={importLabel}>
                <span className="hidden sm:inline">{importLabel}</span>
              </Button>
            )}
            {onExport && (
              <Button variant="ghost" size="sm" icon={Download} onClick={onExport} title={exportLabel}>
                <span className="hidden sm:inline">{exportLabel}</span>
              </Button>
            )}
            {perPage && (
              <div className="flex items-center gap-2">
                <Select
                  value={String(perPage.value)}
                  onChange={(value) => perPage.onChange(Number(value))}
                  options={perPage.options.map((n) => ({ value: String(n), label: String(n) }))}
                  className="min-w-[80px]"
                />
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {perPage.label ?? 'Per page'}
                </span>
              </div>
            )}
            {viewMode && (
              <div className="flex items-center gap-1 bg-muted rounded-lg p-1 border border-border">
                <button
                  type="button"
                  onClick={() => viewMode.onChange('card')}
                  className={`p-1.5 rounded transition-colors ${
                    viewMode.value === 'card'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={viewMode.cardLabel ?? 'Card view'}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => viewMode.onChange('list')}
                  className={`p-1.5 rounded transition-colors ${
                    viewMode.value === 'list'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={viewMode.listLabel ?? 'List view'}
                >
                  <List className="h-4 w-4" />
                </button>
              </div>
            )}
            {bulkSelect && !bulkSelect.disabled && (
              <Button variant="ghost" size="sm" icon={CheckSquare} onClick={bulkSelect.onClick}>
                {bulkSelect.label}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
