import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { Field } from './ui';

interface LocationPickerProps {
  locationSearch: string;
  onLocationSearchChange: (value: string) => void;
  availableLocations: string[];
  visibleLocations: string[];
  selectedLocations: string[];
  onSelectedLocationsChange: (next: string[]) => void;
}

/**
 * The trigger deliberately shares its skin with every other control in the
 * sidebar. It previously used slate/purple utilities that existed nowhere else,
 * so the one combobox in the app looked like it came from a different product.
 */
const TRIGGER =
  'flex w-full items-center gap-2 rounded-[6px] border bg-input px-3 py-2.5 text-left ' +
  'text-[13px] transition-colors';

export function LocationPicker({
  locationSearch,
  onLocationSearchChange,
  availableLocations,
  visibleLocations,
  selectedLocations,
  onSelectedLocationsChange,
}: LocationPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  // Escape closes and hands focus back to the trigger, so keyboard users are
  // not stranded inside a list they cannot dismiss.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const allVisibleSelected =
    visibleLocations.length > 0 && visibleLocations.every((loc) => selectedLocations.includes(loc));

  const summary =
    selectedLocations.length === 0
      ? 'Select locations…'
      : selectedLocations.length === 1
        ? selectedLocations[0]
        : `${selectedLocations.length} locations`;

  return (
    <Field
      label="Locations"
      hint={
        selectedLocations.length > 0
          ? `${selectedLocations.length} selected`
          : 'At least one is required to search.'
      }
    >
      <div ref={containerRef} className="relative w-full">
        {isOpen ? (
          <div className={`${TRIGGER} border-accent-line`}>
            <Search size={13} aria-hidden="true" className="shrink-0 text-ink-3" />
            <input
              type="text"
              autoFocus
              value={locationSearch}
              onChange={(e) => onLocationSearchChange(e.target.value)}
              placeholder="Type to filter…"
              aria-label="Filter locations"
              className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-ink outline-none"
            />
            <ChevronDown
              size={14}
              aria-hidden="true"
              className="shrink-0 rotate-180 text-ink-3 transition-transform"
            />
          </div>
        ) : (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setIsOpen(true)}
            aria-expanded={false}
            aria-haspopup="listbox"
            className={`${TRIGGER} cursor-pointer border-transparent hover:bg-input-hover`}
          >
            <span
              className={`min-w-0 flex-1 truncate ${
                selectedLocations.length > 0 ? 'text-ink' : 'text-ink-3'
              }`}
            >
              {summary}
            </span>
            <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
          </button>
        )}

        {isOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 flex max-h-[280px] w-full flex-col overflow-hidden rounded-[6px] border border-line bg-raised shadow-lg">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-2 py-1.5">
              <span className="pl-1 text-[10.5px] text-ink-3">
                {visibleLocations.length.toLocaleString()} shown
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={visibleLocations.length === 0 || allVisibleSelected}
                  onClick={() =>
                    onSelectedLocationsChange([
                      ...selectedLocations,
                      ...visibleLocations.filter((loc) => !selectedLocations.includes(loc)),
                    ])
                  }
                  className="cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-input hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={selectedLocations.length === 0}
                  onClick={() =>
                    onSelectedLocationsChange(
                      selectedLocations.filter((loc) => !visibleLocations.includes(loc)),
                    )
                  }
                  className="cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5" role="listbox">
              {visibleLocations.length === 0 && (
                <p className="px-2 py-3 text-center text-[12px] text-ink-3">
                  {availableLocations.length === 0 ? 'Loading locations…' : 'No matches'}
                </p>
              )}
              {visibleLocations.map((loc) => {
                const checked = selectedLocations.includes(loc);
                return (
                  <label
                    key={loc}
                    className="flex cursor-pointer items-center gap-2.5 rounded-[4px] px-2 py-1.5 transition-colors hover:bg-input"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        onSelectedLocationsChange(
                          e.target.checked
                            ? [...selectedLocations, loc]
                            : selectedLocations.filter((l) => l !== loc),
                        )
                      }
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded-[3px] accent-[var(--c-accent)]"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-[12px] ${
                        checked ? 'text-ink' : 'text-ink-2'
                      }`}
                    >
                      {loc}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Field>
  );
}
