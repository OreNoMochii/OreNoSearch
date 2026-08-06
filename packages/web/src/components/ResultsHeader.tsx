import { Chip } from './ui';

export interface ActiveFilter {
  id: string;
  label: string;
  onRemove: () => void;
}

interface ResultsHeaderProps {
  total: number | null;
  /** True when `total` came from a planner estimate and is a floor, not a count. */
  totalIsCapped: boolean;
  shown: number;
  selectedCount: number;
  filters: ActiveFilter[];
  onClearAll: () => void;
}

export function ResultsHeader({
  total,
  totalIsCapped,
  shown,
  selectedCount,
  filters,
  onClearAll,
}: ResultsHeaderProps) {
  if (total === null && filters.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {total !== null && (
        <p className="text-[13px] text-ink-2">
          <span className="font-semibold tabular-nums text-ink">
            {total.toLocaleString()}
            {/* A capped total is a floor from the query planner, not a count.
                Rendering it bare asserted a precision the number does not have
                — a search with 24,127 matches displayed a flat "10,000". */}
            {totalIsCapped ? '+' : ''}
          </span>{' '}
          {totalIsCapped ? 'or more records match' : 'records match'} your constraints.
          {shown > 0 && <> Showing the first {shown}.</>}
          {selectedCount > 0 && (
            <span className="text-accent"> · {selectedCount} selected for outreach</span>
          )}
        </p>
      )}

      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((f) => (
            <Chip key={f.id} onRemove={f.onRemove} removeLabel={`Remove filter: ${f.label}`}>
              {f.label}
            </Chip>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="cursor-pointer border-none bg-transparent px-1 text-[11px] text-ink-3 transition-colors hover:text-danger"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
