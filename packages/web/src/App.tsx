import { useState, useEffect, useMemo, useDeferredValue } from 'react';
import {
  getAvailableLocations,
  type BooleanHit,
  runSqlBooleanSearch,
  runBooleanSearch,
} from './searchClient';
import { SearchSidebar } from './components/SearchSidebar';
import { OutreachSidebar } from './components/OutreachSidebar';
import { CandidateCard } from './components/CandidateCard';
import { CandidateProfileModal } from './components/CandidateProfileModal';
import { ResultsHeader, type ActiveFilter } from './components/ResultsHeader';
import { useModelCatalog } from './hooks/useModelCatalog';
import { useTheme } from './hooks/useTheme';

const API_BASE_URL = '';
const PERSIST_DEBOUNCE_MS = 400;

function App() {
  // Search State
  const [mustNot, setMustNot] = useState(() => localStorage.getItem('search_mustNot') || '');
  const [andGroups, setAndGroups] = useState<string[]>(() => {
    const saved = localStorage.getItem('search_andGroups');
    return saved ? JSON.parse(saved) : [];
  });
  const [limit, setLimit] = useState<number>(
    () => Number(localStorage.getItem('search_limit')) || 25,
  );
  const [minExp, setMinExp] = useState<number | ''>(() => {
    const saved = localStorage.getItem('search_minExp');
    return saved ? Number(saved) : '';
  });
  const [maxExp, setMaxExp] = useState<number | ''>(() => {
    const saved = localStorage.getItem('search_maxExp');
    return saved ? Number(saved) : '';
  });
  const [requireOneYearCurrentRole, setRequireOneYearCurrentRole] = useState(
    () => localStorage.getItem('search_requireOneYear') === 'true',
  );
  const [excludeCompanies, setExcludeCompanies] = useState(
    () => localStorage.getItem('search_excludeCompanies') || '',
  );
  const [currentRoleKeywords, setCurrentRoleKeywords] = useState(
    () => localStorage.getItem('search_currentRoleKeywords') || '',
  );

  // Results State
  const [loadingState, setLoadingState] = useState<'none' | 'sql' | 'meili'>('none');
  const [lastSearchMode, setLastSearchMode] = useState<'sql' | 'meili'>('meili');
  const [results, setResults] = useState<BooleanHit[]>([]);
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  // The server bounds its count for speed, so totalMatches can be a floor.
  // Rendering it bare would assert a precision it does not have.
  const [totalIsCapped, setTotalIsCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Profile modal + outreach selection
  const [profileHit, setProfileHit] = useState<BooleanHit | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visibleResults = useMemo(
    () => results.filter((r) => !excluded.has(r.folder_id)),
    [results, excluded],
  );

  // Locations State
  const [selectedLocations, setSelectedLocations] = useState<string[]>(() => {
    const saved = localStorage.getItem('search_selectedLocations');
    return saved ? JSON.parse(saved) : [];
  });
  const [availableLocations, setAvailableLocations] = useState<string[]>([]);
  const [locationSearch, setLocationSearch] = useState('');
  const deferredLocationSearch = useDeferredValue(locationSearch);
  const visibleLocations = useMemo(
    () =>
      availableLocations.filter((loc) =>
        loc.toLowerCase().includes(deferredLocationSearch.toLowerCase()),
      ),
    [availableLocations, deferredLocationSearch],
  );

  useEffect(() => {
    getAvailableLocations().then(setAvailableLocations).catch(console.error);
  }, []);

  // Outreach State
  const [outreachJd, setOutreachJd] = useState(() => localStorage.getItem('outreach_jd') || '');
  const [outreachEmail, setOutreachEmail] = useState(
    () => localStorage.getItem('outreach_email') || '',
  );
  const [screeningEngine, setScreeningEngine] = useState(
    () => localStorage.getItem('outreach_engine') || 'llm',
  );
  const [selectedProvider, setSelectedProvider] = useState(
    () => localStorage.getItem('outreach_provider') || 'deepinfra',
  );
  const [selectedModel, setSelectedModel] = useState(
    () => localStorage.getItem('outreach_model') || 'deepseek-ai/DeepSeek-V3.2',
  );
  const [adjacentRoles, setAdjacentRoles] = useState(
    () => localStorage.getItem('outreach_adjacent') || '',
  );
  const [jobName, setJobName] = useState(() => localStorage.getItem('outreach_jobName') || '');
  const [companyName, setCompanyName] = useState(
    () => localStorage.getItem('outreach_companyName') || '',
  );

  const [bypassDeduplication, setBypassDeduplication] = useState(
    () => localStorage.getItem('outreach_bypassDeduplication') === 'true',
  );
  const [useCompanyIntel, setUseCompanyIntel] = useState(
    () => localStorage.getItem('outreach_useCompanyIntel') !== 'false',
  );
  const [usePipeline, setUsePipeline] = useState(
    () => localStorage.getItem('outreach_usePipeline') === 'true',
  );
  const [pipelineTopN, setPipelineTopN] = useState(() =>
    parseInt(localStorage.getItem('outreach_topN') || '700'),
  );
  const [pipelineTopK, setPipelineTopK] = useState(() =>
    parseInt(localStorage.getItem('outreach_topK') || '300'),
  );
  const [treeTopK, setTreeTopK] = useState(() =>
    parseInt(localStorage.getItem('outreach_treeTopK') || '1000'),
  );
  const [pipelineMinExp, setPipelineMinExp] = useState<number | ''>(() => {
    const saved = localStorage.getItem('outreach_minExp');
    return saved ? parseInt(saved) : '';
  });
  const [pipelineMaxExp, setPipelineMaxExp] = useState<number | ''>(() => {
    const saved = localStorage.getItem('outreach_maxExp');
    return saved ? parseInt(saved) : '';
  });

  const [outreachStatus, setOutreachStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const theme = useTheme();
  const modelCatalog = useModelCatalog();
  const availableProviders = useMemo(
    () => Array.from(new Set(modelCatalog.models.map((m) => m.provider))),
    [modelCatalog.models],
  );

  const providerModels = useMemo(
    () => modelCatalog.models.filter((m) => m.provider === selectedProvider),
    [modelCatalog.models, selectedProvider],
  );

  /**
   * The model actually in force.
   *
   * A persisted `selectedModel` can belong to a provider the user has since
   * switched away from. This was previously reconciled by a setState inside an
   * effect, which meant one render where the dropdown showed a model that was
   * not in its own option list — and a submit in that window sent the stale id.
   * Deriving it removes both the extra render and the window.
   */
  const effectiveModel = useMemo(() => {
    if (providerModels.length === 0) return selectedModel;
    return providerModels.some((m) => m.id === selectedModel)
      ? selectedModel
      : providerModels[0].id;
  }, [providerModels, selectedModel]);

  // Persist Search State
  useEffect(() => {
    const id = window.setTimeout(() => {
      localStorage.setItem('search_mustNot', mustNot);
      localStorage.setItem('search_andGroups', JSON.stringify(andGroups));
      localStorage.setItem('search_limit', limit.toString());
      localStorage.setItem('search_minExp', minExp.toString());
      localStorage.setItem('search_maxExp', maxExp.toString());
      localStorage.setItem('search_requireOneYear', requireOneYearCurrentRole.toString());
      localStorage.setItem('search_excludeCompanies', excludeCompanies);
      localStorage.setItem('search_currentRoleKeywords', currentRoleKeywords);
      localStorage.setItem('search_selectedLocations', JSON.stringify(selectedLocations));
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [
    mustNot,
    andGroups,
    limit,
    minExp,
    maxExp,
    requireOneYearCurrentRole,
    excludeCompanies,
    currentRoleKeywords,
    selectedLocations,
  ]);

  // Persist Outreach State
  useEffect(() => {
    const id = window.setTimeout(() => {
      localStorage.setItem('outreach_jd', outreachJd);
      localStorage.setItem('outreach_email', outreachEmail);
      localStorage.setItem('outreach_adjacent', adjacentRoles);
      localStorage.setItem('outreach_jobName', jobName);
      localStorage.setItem('outreach_companyName', companyName);
      localStorage.setItem('outreach_engine', screeningEngine);
      localStorage.setItem('outreach_provider', selectedProvider);
      localStorage.setItem('outreach_model', effectiveModel);
      localStorage.setItem('outreach_bypassDeduplication', bypassDeduplication.toString());
      localStorage.setItem('outreach_useCompanyIntel', useCompanyIntel.toString());
      localStorage.setItem('outreach_usePipeline', usePipeline.toString());
      localStorage.setItem('outreach_topN', pipelineTopN.toString());
      localStorage.setItem('outreach_topK', pipelineTopK.toString());
      localStorage.setItem('outreach_treeTopK', treeTopK.toString());
      localStorage.setItem('outreach_minExp', pipelineMinExp.toString());
      localStorage.setItem('outreach_maxExp', pipelineMaxExp.toString());
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [
    outreachJd,
    outreachEmail,
    screeningEngine,
    selectedProvider,
    effectiveModel,
    adjacentRoles,
    jobName,
    companyName,
    bypassDeduplication,
    useCompanyIntel,
    usePipeline,
    pipelineTopN,
    pipelineTopK,
    treeTopK,
    pipelineMinExp,
    pipelineMaxExp,
  ]);

  /**
   * Chips reflecting the constraints actually in force.
   *
   * Derived from state rather than hardcoded, so a chip cannot claim a filter
   * that is not applied — and removing one genuinely clears it.
   */
  const activeFilters = useMemo<ActiveFilter[]>(() => {
    const chips: ActiveFilter[] = [];

    for (const loc of selectedLocations) {
      chips.push({
        id: `loc:${loc}`,
        label: loc,
        onRemove: () => setSelectedLocations((prev) => prev.filter((l) => l !== loc)),
      });
    }

    andGroups.forEach((group, i) => {
      if (!group.trim()) return;
      chips.push({
        id: `group:${i}`,
        label: group.length > 40 ? `${group.slice(0, 40)}…` : group,
        onRemove: () => setAndGroups((prev) => prev.filter((_, idx) => idx !== i)),
      });
    });

    if (mustNot.trim()) {
      chips.push({
        id: 'not',
        label: `NOT: ${mustNot}`,
        onRemove: () => setMustNot(''),
      });
    }

    if (minExp !== '' || maxExp !== '') {
      chips.push({
        id: 'exp',
        label: `${minExp === '' ? 0 : minExp}–${maxExp === '' ? '50+' : maxExp} yrs`,
        onRemove: () => {
          setMinExp('');
          setMaxExp('');
        },
      });
    }

    if (excludeCompanies.trim()) {
      chips.push({
        id: 'exclco',
        label: `Excluding: ${excludeCompanies}`,
        onRemove: () => setExcludeCompanies(''),
      });
    }

    if (currentRoleKeywords.trim()) {
      chips.push({
        id: 'rolekw',
        label: `Role: ${currentRoleKeywords}`,
        onRemove: () => setCurrentRoleKeywords(''),
      });
    }

    return chips;
  }, [
    selectedLocations,
    andGroups,
    mustNot,
    minExp,
    maxExp,
    excludeCompanies,
    currentRoleKeywords,
  ]);

  const clearAllFilters = () => {
    setSelectedLocations([]);
    setAndGroups([]);
    setMustNot('');
    setMinExp('');
    setMaxExp('');
    setExcludeCompanies('');
    setCurrentRoleKeywords('');
  };

  const handleSearch = async (useSql: boolean) => {
    if (selectedLocations.length === 0) {
      setError('Please select at least one location before searching.');
      return;
    }
    setError(null);
    setLoadingState(useSql ? 'sql' : 'meili');
    try {
      const parsedExcludeCompanies = excludeCompanies
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedCurrentRoleKeywords = currentRoleKeywords
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const queryParams = {
        should: [],
        must: [],
        mustNot: mustNot
          .split(/,|\bOR\b|\|/i)
          .map((s) => s.trim())
          .filter(Boolean),
        andGroups: andGroups
          .map((g) =>
            g
              .split(/,|\bOR\b|\|/i)
              .map((s) => s.trim())
              .filter(Boolean),
          )
          .filter((g) => g.length > 0),
        limit,
        minExp: minExp === '' ? undefined : minExp,
        maxExp: maxExp === '' ? undefined : maxExp,
        minMonthsInCurrentRole: requireOneYearCurrentRole ? 12 : undefined,
        excludeCompanies: parsedExcludeCompanies.length > 0 ? parsedExcludeCompanies : undefined,
        currentRoleKeywords:
          parsedCurrentRoleKeywords.length > 0 ? parsedCurrentRoleKeywords : undefined,
        locationKeywords: selectedLocations.length > 0 ? selectedLocations : undefined,
      };

      const resp = useSql
        ? await runSqlBooleanSearch(queryParams)
        : await runBooleanSearch(queryParams);
      setResults(resp.hits);
      setTotalMatches(resp.total);
      setTotalIsCapped(resp.totalIsCapped === true);
      setLastSearchMode(useSql ? 'sql' : 'meili');
      // A new result set invalidates per-result state from the previous one.
      setExcluded(new Set());
      setSelected(new Set());
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : '') || 'An unexpected error occurred');
      setResults([]);
      setTotalMatches(null);
      setTotalIsCapped(false);
    } finally {
      setLoadingState('none');
    }
  };

  const handleOutreachSubmit = async () => {
    if (!outreachJd || !outreachEmail || !jobName || !companyName) {
      setOutreachStatus('Please provide all required fields (Job Name, Company, JD, and Email).');
      return;
    }
    setIsSubmitting(true);
    setOutreachStatus(null);
    try {
      let searchParams: Record<string, unknown> | undefined;
      let candidateUrls: string[] | undefined;

      if (!usePipeline || totalMatches !== null) {
        const parsedExcludeCompanies = excludeCompanies
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const parsedCurrentRoleKeywords = currentRoleKeywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const parsedMustNot = mustNot
          .split(/,|\bOR\b|\|/i)
          .map((s) => s.trim())
          .filter(Boolean);
        const parsedAndGroups = andGroups
          .map((g) =>
            g
              .split(/,|\bOR\b|\|/i)
              .map((s) => s.trim())
              .filter(Boolean),
          )
          .filter((g) => g.length > 0);

        if (lastSearchMode === 'sql') {
          searchParams = {
            should: [],
            must: [],
            mustNot: parsedMustNot,
            andGroups: parsedAndGroups,
            locations: selectedLocations,
            minExp: minExp === '' ? undefined : minExp,
            maxExp: maxExp === '' ? undefined : maxExp,
            excludeCompanies:
              parsedExcludeCompanies.length > 0 ? parsedExcludeCompanies : undefined,
            currentRoleKeywords:
              parsedCurrentRoleKeywords.length > 0 ? parsedCurrentRoleKeywords : undefined,
          };
        } else {
          const resp = await runBooleanSearch({
            should: [],
            must: [],
            mustNot: parsedMustNot,
            andGroups: parsedAndGroups,
            limit: 100000,
            minExp: minExp === '' ? undefined : minExp,
            maxExp: maxExp === '' ? undefined : maxExp,
            minMonthsInCurrentRole: requireOneYearCurrentRole ? 12 : undefined,
            excludeCompanies:
              parsedExcludeCompanies.length > 0 ? parsedExcludeCompanies : undefined,
            currentRoleKeywords:
              parsedCurrentRoleKeywords.length > 0 ? parsedCurrentRoleKeywords : undefined,
            locationKeywords: selectedLocations.length > 0 ? selectedLocations : undefined,
          });
          candidateUrls = resp.hits.map((h) => h.folder_id).filter(Boolean);
        }
      }

      const response = await fetch(`${API_BASE_URL}/api/outreach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchParams,
          candidateUrls,
          jd: outreachJd,
          email: outreachEmail,
          model:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm'
              ? effectiveModel
              : undefined,
          adjacentRoles:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm' ? adjacentRoles : undefined,
          jobName,
          companyName,
          bypassDeduplication,
          useCompanyIntel,
          usePipeline:
            screeningEngine === 'tree' || screeningEngine === 'tree_llm' ? false : usePipeline,
          screeningEngine,
          topN:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm' ? pipelineTopN : undefined,
          topK:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm' ? pipelineTopK : undefined,
          treeTopK:
            screeningEngine === 'tree' || screeningEngine === 'tree_llm' ? treeTopK : undefined,
          minExp:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm'
              ? pipelineMinExp === ''
                ? undefined
                : pipelineMinExp
              : undefined,
          maxExp:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm'
              ? pipelineMaxExp === ''
                ? undefined
                : pipelineMaxExp
              : undefined,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to trigger outreach');
      }

      const result = await response.json();
      setOutreachStatus(`Batch Accepted! ${result.queue_status || ''}`);
      setTimeout(() => {
        setIsSubmitting(false);
        setOutreachStatus(null);
      }, 3000);
    } catch (err: unknown) {
      setOutreachStatus(
        (err instanceof Error ? err.message : '') || 'Network error connecting to API.',
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-base">
      {/* Left Sidebar */}
      <SearchSidebar
        mustNot={mustNot}
        setMustNot={setMustNot}
        andGroups={andGroups}
        setAndGroups={setAndGroups}
        limit={limit}
        setLimit={setLimit}
        minExp={minExp}
        setMinExp={setMinExp}
        maxExp={maxExp}
        setMaxExp={setMaxExp}
        requireOneYearCurrentRole={requireOneYearCurrentRole}
        setRequireOneYearCurrentRole={setRequireOneYearCurrentRole}
        excludeCompanies={excludeCompanies}
        setExcludeCompanies={setExcludeCompanies}
        currentRoleKeywords={currentRoleKeywords}
        setCurrentRoleKeywords={setCurrentRoleKeywords}
        locationSearch={locationSearch}
        setLocationSearch={setLocationSearch}
        availableLocations={availableLocations}
        visibleLocations={visibleLocations}
        selectedLocations={selectedLocations}
        setSelectedLocations={setSelectedLocations}
        onSearch={handleSearch}
        loadingState={loadingState}
        themeChoice={theme.choice}
        onCycleTheme={theme.cycle}
      />

      {/* Main Content */}
      <main className="flex h-full flex-1 flex-col gap-5 overflow-y-auto bg-base p-6">
        {error && (
          <div
            role="alert"
            className="rounded-[6px] bg-danger-soft px-4 py-3 text-[13px] text-danger"
          >
            {error}
          </div>
        )}

        <ResultsHeader
          total={totalMatches}
          totalIsCapped={totalIsCapped}
          shown={visibleResults.length}
          selectedCount={selected.size}
          filters={activeFilters}
          onClearAll={clearAllFilters}
        />

        <div className="flex flex-col gap-3">
          {loadingState !== 'none' ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-36 w-full animate-pulse rounded-[8px] bg-raised"
              />
            ))
          ) : visibleResults.length === 0 && totalMatches !== null ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center">
              <p className="text-[15px] font-semibold text-ink">No candidates matched.</p>
              <p className="max-w-[380px] text-[13px] text-ink-3">
                Try loosening a constraint — widen the experience range, drop a NOT term, or add
                another location.
              </p>
            </div>
          ) : (
            visibleResults.map((hit, idx) => (
              <CandidateCard
                key={hit.folder_id || idx}
                hit={hit}
                idx={idx}
                onOpenProfile={setProfileHit}
                onExclude={(h) => setExcluded((prev) => new Set(prev).add(h.folder_id))}
                onSelect={(h) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(h.folder_id)) next.delete(h.folder_id);
                    else next.add(h.folder_id);
                    return next;
                  })
                }
                isSelected={selected.has(hit.folder_id)}
              />
            ))
          )}
        </div>
      </main>

      {/* Right Sidebar */}
      <OutreachSidebar
        jobName={jobName}
        setJobName={setJobName}
        companyName={companyName}
        setCompanyName={setCompanyName}
        outreachEmail={outreachEmail}
        setOutreachEmail={setOutreachEmail}
        outreachJd={outreachJd}
        setOutreachJd={setOutreachJd}
        adjacentRoles={adjacentRoles}
        setAdjacentRoles={setAdjacentRoles}
        screeningEngine={screeningEngine}
        setScreeningEngine={setScreeningEngine}
        selectedProvider={selectedProvider}
        setSelectedProvider={setSelectedProvider}
        selectedModel={effectiveModel}
        setSelectedModel={setSelectedModel}
        bypassDeduplication={bypassDeduplication}
        setBypassDeduplication={setBypassDeduplication}
        useCompanyIntel={useCompanyIntel}
        setUseCompanyIntel={setUseCompanyIntel}
        usePipeline={usePipeline}
        setUsePipeline={setUsePipeline}
        pipelineTopN={pipelineTopN}
        setPipelineTopN={setPipelineTopN}
        pipelineTopK={pipelineTopK}
        setPipelineTopK={setPipelineTopK}
        treeTopK={treeTopK}
        setTreeTopK={setTreeTopK}
        pipelineMinExp={pipelineMinExp}
        setPipelineMinExp={setPipelineMinExp}
        pipelineMaxExp={pipelineMaxExp}
        setPipelineMaxExp={setPipelineMaxExp}
        isSubmitting={isSubmitting}
        status={outreachStatus}
        onSubmit={handleOutreachSubmit}
        providerModels={providerModels}
        availableProviders={availableProviders}
      />

      <CandidateProfileModal
        hit={profileHit}
        onClose={() => setProfileHit(null)}
        onShortlist={(h) => {
          setSelected((prev) => new Set(prev).add(h.folder_id));
          setProfileHit(null);
        }}
      />
    </div>
  );
}

export default App;
