import type { ReactElement, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { SelectField, type SelectOption } from "./select-field.tsx";

export interface LoadMorePageSize {
  /** Names the select. */
  label: string;
  /** The chosen size, one of the `options` values. */
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
}

export interface LoadMoreProps {
  /** The count line, for example "Showing 48 of 1,234"; it is a live region, so a growing list is announced. */
  count: ReactNode;
  /** Whether more results follow the ones shown. */
  hasMore: boolean;
  /** The label of the button that loads them. */
  loadMoreLabel: string;
  onLoadMore: () => void;
  /** Shows the wait on the button and keeps it from being pressed again. */
  loading?: boolean;
  /** How many each load adds; omitted, the list offers no choice. */
  pageSize?: LoadMorePageSize;
}

/**
 * What sits under a list with keyset pagination (doc 03 `load-more`): the count line, the button that loads the next
 * results (there is no page number to jump to) and the choice of how many each load adds.
 */
export function LoadMore({ count, hasMore, loadMoreLabel, onLoadMore, loading = false, pageSize }: LoadMoreProps): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between" data-slot="load-more">
      <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
        {count}
      </p>
      <div className="flex flex-wrap items-end justify-center gap-3">
        {pageSize === undefined ? null : (
          <SelectField className="w-28" label={pageSize.label} onValueChange={pageSize.onValueChange} options={pageSize.options} value={pageSize.value} />
        )}
        {hasMore ? (
          <Button loading={loading} onClick={onLoadMore} variant="outline">
            {loadMoreLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
