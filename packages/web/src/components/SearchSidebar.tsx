import { Trash2, Plus, Search, Moon, Sun, Monitor, Sparkles, Loader2 } from 'lucide-react';
import { LocationPicker } from './LocationPicker';
import {
  Section,
  Field,
  TextInput,
  CodeInput,
  Button,
  Chip,
  Checkbox,
  Divider,
} from './ui';
import type { ThemeChoice } from '../hooks/useTheme';

/** The icon shows what is in force now; the label announces what a click does. */
const THEME_UI: Record<ThemeChoice, { icon: typeof Sun; now: string; next: string }> = {
  system: { icon: Monitor, now: 'Following system theme', next: 'light' },
  light: { icon: Sun, now: 'Light theme', next: 'dark' },
  dark: { icon: Moon, now: 'Dark theme', next: 'system' },
};

export interface SearchSidebarProps {
  mustNot: string;
  setMustNot: (v: string) => void;
  andGroups: string[];
  setAndGroups: (v: string[]) => void;
  limit: number;
  setLimit: (v: number) => void;
  minExp: number | '';
  setMinExp: (v: number | '') => void;
  maxExp: number | '';
  setMaxExp: (v: number | '') => void;
  requireOneYearCurrentRole: boolean;
  setRequireOneYearCurrentRole: (v: boolean) => void;
  excludeCompanies: string;
  setExcludeCompanies: (v: string) => void;
  currentRoleKeywords: string;
  setCurrentRoleKeywords: (v: string) => void;
  locationSearch: string;
  setLocationSearch: (v: string) => void;
  availableLocations: string[];
  visibleLocations: string[];
  selectedLocations: string[];
  setSelectedLocations: (v: string[]) => void;
  onSearch: (useSql: boolean) => void;
  loadingState: 'none' | 'sql' | 'meili';
  themeChoice: ThemeChoice;
  onCycleTheme: () => void;
}

export function SearchSidebar({
  mustNot,
  setMustNot,
  andGroups,
  setAndGroups,
  limit,
  setLimit,
  minExp,
  setMinExp,
  maxExp,
  setMaxExp,
  requireOneYearCurrentRole,
  setRequireOneYearCurrentRole,
  excludeCompanies,
  setExcludeCompanies,
  currentRoleKeywords,
  setCurrentRoleKeywords,
  locationSearch,
  setLocationSearch,
  availableLocations,
  visibleLocations,
  selectedLocations,
  setSelectedLocations,
  onSearch,
  loadingState,
  themeChoice,
  onCycleTheme,
}: SearchSidebarProps) {
  const addGroup = () => setAndGroups([...andGroups, '']);
  const updateGroup = (i: number, val: string) => {
    const next = [...andGroups];
    next[i] = val;
    setAndGroups(next);
  };
  const removeGroup = (i: number) => setAndGroups(andGroups.filter((_, idx) => idx !== i));

  const clearAll = () => {
    setMustNot('');
    setAndGroups([]);
    setMinExp('');
    setMaxExp('');
    setRequireOneYearCurrentRole(false);
    setExcludeCompanies('');
    setCurrentRoleKeywords('');
    setSelectedLocations([]);
  };

  const hasFilters =
    selectedLocations.length > 0 ||
    andGroups.some((g) => g.trim()) ||
    mustNot.trim() !== '' ||
    minExp !== '' ||
    maxExp !== '' ||
    excludeCompanies.trim() !== '' ||
    currentRoleKeywords.trim() !== '';

  const busy = loadingState !== 'none';
  const themeUi = THEME_UI[themeChoice];
  const ThemeIcon = themeUi.icon;

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-r border-line bg-panel p-6 pb-24">
      {/* ── Masthead ─────────────────────────────────────────────────── */}
      <div className="flex w-full items-center justify-between">
        <h1 className="flex items-center gap-2 text-[17px] font-bold text-ink">
          <Search size={15} aria-hidden="true" className="text-accent" />
          Deep Search
        </h1>
        <button
          type="button"
          onClick={onCycleTheme}
          aria-label={`${themeUi.now}. Switch to ${themeUi.next}.`}
          title={`${themeUi.now} — click for ${themeUi.next}`}
          className="flex cursor-pointer items-center justify-center rounded-[6px] border-none bg-input p-2 text-ink-2 transition-colors hover:bg-input-hover hover:text-ink"
        >
          <ThemeIcon size={14} aria-hidden="true" />
        </button>
      </div>

      {/* ── Active filters ───────────────────────────────────────────── */}
      <Section
        title="Search constraints"
        action={
          hasFilters ? (
            <button
              type="button"
              onClick={clearAll}
              className="cursor-pointer border-none bg-transparent p-0 text-[11px] text-accent transition-colors hover:text-accent-hover"
            >
              Clear all
            </button>
          ) : undefined
        }
      >
        {hasFilters ? (
          <div className="flex flex-wrap gap-1.5">
            {selectedLocations.map((loc) => (
              <Chip
                key={loc}
                removeLabel={`Remove location ${loc}`}
                onRemove={() => setSelectedLocations(selectedLocations.filter((l) => l !== loc))}
              >
                {loc}
              </Chip>
            ))}
            {(minExp !== '' || maxExp !== '') && (
              <Chip
                removeLabel="Clear experience range"
                onRemove={() => {
                  setMinExp('');
                  setMaxExp('');
                }}
              >
                {minExp === '' ? 0 : minExp}–{maxExp === '' ? '50+' : maxExp} yrs
              </Chip>
            )}
          </div>
        ) : (
          <p className="text-[11.5px] text-ink-3">No filters yet. Pick a location to begin.</p>
        )}
      </Section>

      <Divider />

      {/* ── Where ────────────────────────────────────────────────────── */}
      <Section title="Where">
        <LocationPicker
          locationSearch={locationSearch}
          onLocationSearchChange={setLocationSearch}
          availableLocations={availableLocations}
          visibleLocations={visibleLocations}
          selectedLocations={selectedLocations}
          onSelectedLocationsChange={setSelectedLocations}
        />
      </Section>

      <Divider />

      {/* ── Keywords ─────────────────────────────────────────────────── */}
      <Section
        title="Keywords"
        action={
          <button
            type="button"
            onClick={addGroup}
            className="flex cursor-pointer items-center gap-1 rounded-[4px] border-none bg-input px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-input-hover"
          >
            <Plus size={11} aria-hidden="true" /> Add group
          </button>
        }
      >
        <Field
          label="AND groups"
          hint="Terms inside a box are OR'd. Separate boxes are AND'd together."
        >
          <div className="flex w-full flex-col gap-1.5">
            {andGroups.length === 0 && (
              <p className="text-[11.5px] text-ink-3">None — every candidate matches.</p>
            )}
            {andGroups.map((group, i) => (
              <div key={i} className="flex w-full items-center gap-1.5">
                <CodeInput
                  value={group}
                  onChange={(e) => updateGroup(i, e.target.value)}
                  placeholder="java OR spring OR python"
                  aria-label={`AND group ${i + 1}`}
                />
                <button
                  type="button"
                  onClick={() => removeGroup(i)}
                  aria-label={`Remove group ${i + 1}`}
                  className="shrink-0 cursor-pointer rounded-[4px] border-none bg-transparent p-2 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </Field>

        <Field label="NOT terms (exclude)">
          <TextInput
            value={mustNot}
            onChange={(e) => setMustNot(e.target.value)}
            placeholder="e.g. temporary, contractor"
          />
        </Field>
      </Section>

      <Divider />

      {/* ── Who ──────────────────────────────────────────────────────── */}
      <Section title="Who">
        <div className="flex w-full gap-2.5">
          <Field label="Min experience">
            <TextInput
              type="number"
              min={0}
              max={60}
              value={minExp}
              onChange={(e) => setMinExp(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
              placeholder="0"
            />
          </Field>
          <Field label="Max experience">
            <TextInput
              type="number"
              min={0}
              max={60}
              value={maxExp}
              onChange={(e) => setMaxExp(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
              placeholder="50+"
            />
          </Field>
        </div>

        <Checkbox checked={requireOneYearCurrentRole} onChange={setRequireOneYearCurrentRole}>
          Only candidates with 1+ year in their current role
        </Checkbox>

        <Field
          label="Exclude current company"
          hint="Matches company names starting with any of these."
        >
          <TextInput
            value={excludeCompanies}
            onChange={(e) => setExcludeCompanies(e.target.value)}
            placeholder="e.g. Google, Apple, 株式会社"
          />
        </Field>

        <Field label="Current role keywords" hint="Comma separated. Any one may match.">
          <TextInput
            value={currentRoleKeywords}
            onChange={(e) => setCurrentRoleKeywords(e.target.value)}
            placeholder="e.g. engineer, 部長, lead"
          />
        </Field>

        <Field label="Max results">
          <TextInput
            type="number"
            min={1}
            max={200}
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10) || 25)}
          />
        </Field>
      </Section>

      {/* ── Run ──────────────────────────────────────────────────────── */}
      <div className="flex w-full flex-col gap-2">
        <Button tone="primary" full disabled={busy} onClick={() => onSearch(true)}>
          {loadingState === 'sql' ? (
            <>
              <Loader2 size={13} aria-hidden="true" className="animate-spin" /> Searching…
            </>
          ) : (
            <>
              <Search size={13} aria-hidden="true" /> Full search (PostgreSQL)
            </>
          )}
        </Button>
        <Button tone="secondary" full disabled={busy} onClick={() => onSearch(false)}>
          {loadingState === 'meili' ? (
            <>
              <Loader2 size={13} aria-hidden="true" className="animate-spin" /> Searching…
            </>
          ) : (
            <>
              <Sparkles size={13} aria-hidden="true" /> Top matches (AI engine)
            </>
          )}
        </Button>
      </div>
    </aside>
  );
}
