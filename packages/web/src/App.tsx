import React, { useState, useEffect, useMemo, useDeferredValue, useId } from 'react';
import { Search, Plus, X, Briefcase, Download, Ban } from 'lucide-react';
import {
  runBooleanSearch,
  getAvailableLocations,
  type BooleanHit,
  runSqlBooleanSearch,
} from './searchClient';
import { motion, AnimatePresence } from 'framer-motion';
import { Modal } from './components/Modal';
import { QueueMonitor } from './components/QueueMonitor';
import { useQueueStatus } from './hooks/useQueueStatus';
import { OutreachForm } from './components/OutreachForm';
import { CandidateCard } from './components/CandidateCard';
import { LocationPicker } from './components/LocationPicker';
import { ExplainableAction } from './components/ExplainableAction';
import { useModelCatalog, formatCost } from './hooks/useModelCatalog';

const API_BASE_URL = '';

/** How long typing must pause before state is written to localStorage. */
const PERSIST_DEBOUNCE_MS = 400;

function App() {
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

  const [loadingState, setLoadingState] = useState<'none' | 'sql' | 'meili'>('none');
  const [lastSearchMode, setLastSearchMode] = useState<'sql' | 'meili'>('meili');
  const [results, setResults] = useState<BooleanHit[]>([]);
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  // B32: the server bounds its count for speed, so totalMatches can be a
  // floor rather than an exact total. Never use it as a fetch limit.
  const [totalIsCapped, setTotalIsCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLocations, setSelectedLocations] = useState<string[]>(() => {
    const saved = localStorage.getItem('search_selectedLocations');
    return saved ? JSON.parse(saved) : [];
  });
  const [availableLocations, setAvailableLocations] = useState<string[]>([]);
  const [locationSearch, setLocationSearch] = useState('');
  const outreachTitleId = useId();

  // The filter previously ran over the full location list on every keystroke,
  // inside a 1600-line render. useDeferredValue keeps typing responsive and
  // useMemo stops the array being rebuilt when unrelated state changes.
  const deferredLocationSearch = useDeferredValue(locationSearch);
  const visibleLocations = useMemo(
    () =>
      availableLocations.filter((loc) =>
        loc.toLowerCase().includes(deferredLocationSearch.toLowerCase()),
      ),
    [availableLocations, deferredLocationSearch],
  );

  // Fetch available locations on mount
  useEffect(() => {
    getAvailableLocations()
      .then((locs) => {
        setAvailableLocations(locs);
      })
      .catch(console.error);
  }, []);

  // Persistence effect.
  //
  // Debounced: localStorage is synchronous and blocks the main thread, and this
  // effect fires on every keystroke in the NOT-terms and AND-group textareas —
  // eight writes plus a JSON.stringify per character typed. It also never wrote
  // excludeCompanies despite listing it as a dependency, so that field was
  // silently not persisted.
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

  // Outreach Modal State
  const [isOutreachModalOpen, setIsOutreachModalOpen] = useState(false);
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

  // Served by /api/models so the picker and the backend cannot disagree about
  // which ids exist.
  const modelCatalog = useModelCatalog();
  const providerModels = useMemo(
    () => modelCatalog.models.filter((m) => m.provider === selectedProvider),
    [modelCatalog.models, selectedProvider],
  );
  const activeModel = useMemo(
    () => modelCatalog.models.find((m) => m.id === selectedModel),
    [modelCatalog.models, selectedModel],
  );

  // Keep the selection valid. Switching provider — or loading a catalogue that
  // no longer carries a previously-saved id — would otherwise leave the select
  // showing one model while `selectedModel` held another, and the campaign
  // would run on the stale one.
  useEffect(() => {
    if (!modelCatalog.loaded || providerModels.length === 0) return;
    if (!providerModels.some((m) => m.id === selectedModel)) {
      setSelectedModel(providerModels[0].id);
    }
  }, [modelCatalog.loaded, providerModels, selectedModel]);
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

  // Outreach persistence effect.
  //
  // Debounced for the same reason as the search effect above, and more acutely:
  // `outreachJd` accepts up to 200,000 characters, so every keystroke in the
  // job-description textarea used to serialise the whole document to disk
  // synchronously — plus thirteen unrelated writes — before the next frame.
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      localStorage.setItem('outreach_jd', outreachJd);
      localStorage.setItem('outreach_email', outreachEmail);
      localStorage.setItem('outreach_adjacent', adjacentRoles);
      localStorage.setItem('outreach_jobName', jobName);
      localStorage.setItem('outreach_companyName', companyName);
      localStorage.setItem('outreach_engine', screeningEngine);
      localStorage.setItem('outreach_provider', selectedProvider);
      localStorage.setItem('outreach_model', selectedModel);
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
    selectedModel,
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

  // Queue polling: backs off when idle, pauses on a hidden tab, aborts on unmount.
  const queueInfo = useQueueStatus();

  const handleExportCSV = () => {
    if (results.length === 0) return;

    const headers = [
      'Name',
      'Headline/Role',
      'Company',
      'Tenure',
      'Move Prob',
      'Hazard',
      'Profile URL',
      'Location',
      'Contacted By',
      'Shared With',
      'Data Added',
    ];
    const csvContent = [
      headers.join(','),
      ...results.map((h) => {
        const row = [
          h.full_name || 'N/A',
          h.ai_latest_role || 'N/A',
          h.ai_latest_company || 'N/A',
          'N/A', // Tenure
          'N/A', // Move Prob
          'N/A', // Hazard
          h.resume_drive_view_url || 'N/A',
          h.ai_latest_location || 'N/A',
          '', // Contacted By
          '', // Shared With
          '', // Data Added
        ];
        return row.map((val) => `"${val.toString().replace(/"/g, '""')}"`).join(',');
      }),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeTitle = jobName ? jobName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() : 'candidates';
    link.setAttribute(
      'download',
      `${safeTitle}_export_${new Date().toISOString().split('T')[0]}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleOutreachSubmit = async () => {
    if (!outreachJd || !outreachEmail || !jobName || !companyName) {
      setOutreachStatus('Please provide all required fields (Job Name, Company, JD, and Email).');
      return;
    }
    setIsSubmitting(true);
    setOutreachStatus(null);
    try {
      // What the campaign screens is described, not shipped.
      //
      // This previously re-ran the search with `limit: 100000`, received every
      // matching row — each carrying up to 50,000 characters of experience
      // text — serialised the lot in the tab, and posted it back. That is
      // hundreds of megabytes for a broad query, and anything past the 10 MB
      // body limit was rejected outright, so large campaigns failed after the
      // browser had already done all the work.
      //
      // The SQL path now sends the query itself and the server re-runs it. The
      // Meilisearch path keeps its browser-side set algebra but sends only the
      // resulting profile URLs, which the server hydrates from Postgres.
      let searchParams: Record<string, unknown> | undefined;
      let candidateUrls: string[] | undefined;

      // With the Advanced Pipeline and no boolean search run, there is nothing
      // to describe: the retrieval microservice sources its own candidates.
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
          // No `limit`: the server applies MAX_CAMPAIGN_CANDIDATES. Passing one
          // from here is how campaigns were previously truncated to the display
          // cap (B32).
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
          // Identity only — roughly 60 bytes per candidate instead of several
          // kilobytes.
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
            screeningEngine === 'llm' || screeningEngine === 'tree_llm' ? selectedModel : undefined,
          adjacentRoles:
            screeningEngine === 'llm' || screeningEngine === 'tree_llm' ? adjacentRoles : undefined,
          jobName: jobName,
          companyName: companyName,
          bypassDeduplication: bypassDeduplication,
          useCompanyIntel: useCompanyIntel,
          usePipeline:
            screeningEngine === 'tree' || screeningEngine === 'tree_llm' ? false : usePipeline,
          screeningEngine: screeningEngine,
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
      const statusMsg = `Batch Accepted! ${result.queue_status || ''}`;
      setOutreachStatus(statusMsg);

      setTimeout(() => {
        setIsOutreachModalOpen(false);
        setIsSubmitting(false); // Only re-enable after modal is gone
        setOutreachStatus(null);
      }, 100);
    } catch (err: unknown) {
      setOutreachStatus(
        (err instanceof Error ? err.message : '') || 'Network error connecting to AI agent API.',
      );
      setIsSubmitting(false); // Re-enable on error so user can fix and try again
    }
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
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : '') || 'An unexpected error occurred');
      setResults([]);
      setTotalMatches(null);
      setTotalIsCapped(false);
    } finally {
      setLoadingState('none');
    }
  };

  const addGroup = () => setAndGroups([...andGroups, '']);
  const updateGroup = (i: number, val: string) => {
    const newGroups = [...andGroups];
    newGroups[i] = val;
    setAndGroups(newGroups);
  };
  const removeGroup = (i: number) => {
    setAndGroups(andGroups.filter((_, idx) => idx !== i));
  };

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="app-container animate-slide-up">
        <header className="header">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5 }}
          >
            <h1>Deep Search</h1>
            <p>
              Deploy ultra-precise boolean filters to pinpoint the exact candidate profiles you
              need.
            </p>
          </motion.div>
        </header>

        <main
          id="main-content"
          className={totalMatches === null ? 'single-column-centered' : 'main-grid'}
        >
          <motion.div
            className="glass-panel"
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            <LocationPicker
              locationSearch={locationSearch}
              onLocationSearchChange={setLocationSearch}
              availableLocations={availableLocations}
              visibleLocations={visibleLocations}
              selectedLocations={selectedLocations}
              onSelectedLocationsChange={setSelectedLocations}
            />

            <div style={{ opacity: selectedLocations.length === 0 ? 0.5 : 1 }}>
              <h2
                style={{
                  fontSize: '1.1rem',
                  color: '#cbd5e1',
                  marginBottom: '1rem',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                Step 2: Boolean Parameters
              </h2>

              <div className="input-group">
                <label
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span>AND Groups (Parenthetical ORs)</span>
                  <button
                    type="button"
                    onClick={addGroup}
                    style={{
                      background: 'rgba(59, 130, 246, 0.2)',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.5rem',
                      fontSize: '0.8rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      border: '1px solid rgba(59, 130, 246, 0.4)',
                    }}
                  >
                    <Plus size={14} /> Add Group
                  </button>
                </label>
                <span className="input-helper" style={{ marginBottom: '0.5rem' }}>
                  Each box is an internal OR. All separate boxes are ANDed together.
                </span>

                <AnimatePresence>
                  {andGroups.map((group, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      style={{ position: 'relative', marginBottom: '0.75rem' }}
                    >
                      <textarea
                        value={group}
                        onChange={(e) => updateGroup(i, e.target.value)}
                        rows={2}
                        placeholder="group terms separated by commas..."
                        style={{
                          paddingRight: '3rem',
                          background: 'rgba(30, 64, 175, 0.15)',
                          borderColor: 'rgba(59, 130, 246, 0.3)',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => removeGroup(i)}
                        style={{
                          position: 'absolute',
                          top: '0.5rem',
                          right: '0.5rem',
                          background: 'rgba(239, 68, 68, 0.15)',
                          color: '#ef4444',
                          border: 'none',
                          borderRadius: '50%',
                          width: '28px',
                          height: '28px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          cursor: 'pointer',
                        }}
                      >
                        <X size={16} />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <div className="input-group">
                <label>NOT terms (Exclude)</label>
                <textarea
                  value={mustNot}
                  onChange={(e) => setMustNot(e.target.value)}
                  rows={2}
                  placeholder="e.g. temporary, contractor"
                />
              </div>

              <div className="input-group" style={{ flexDirection: 'row', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <label>Min Experience (Years)</label>
                  <input
                    type="number"
                    value={minExp}
                    onChange={(e) =>
                      setMinExp(e.target.value === '' ? '' : parseInt(e.target.value))
                    }
                    min={0}
                    max={50}
                    placeholder="0"
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      borderRadius: '0.5rem',
                      background: 'rgba(15, 23, 42, 0.5)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      color: '#fff',
                      boxSizing: 'border-box',
                      outline: 'none',
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label>Max Experience (Years)</label>
                  <input
                    type="number"
                    value={maxExp}
                    onChange={(e) =>
                      setMaxExp(e.target.value === '' ? '' : parseInt(e.target.value))
                    }
                    min={0}
                    max={50}
                    placeholder="50+"
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      borderRadius: '0.5rem',
                      background: 'rgba(15, 23, 42, 0.5)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      color: '#fff',
                      boxSizing: 'border-box',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>

              <div
                className="input-group"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <input
                  type="checkbox"
                  id="requireOneYearCurrentRole"
                  checked={requireOneYearCurrentRole}
                  onChange={(e) => setRequireOneYearCurrentRole(e.target.checked)}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <label
                  htmlFor="requireOneYearCurrentRole"
                  style={{ color: '#cbd5e1', cursor: 'pointer', fontSize: '0.9rem', margin: 0 }}
                >
                  Only keep candidates with 1+ year in current role
                </label>
              </div>

              <div className="input-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Ban size={16} style={{ color: '#f87171' }} />
                  Exclude Current Company (comma separated)
                </label>
                <input
                  type="text"
                  value={excludeCompanies}
                  onChange={(e) => setExcludeCompanies(e.target.value)}
                  placeholder="e.g. Google, Amazon, Rakuten"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: '0.5rem',
                    background: 'rgba(15, 23, 42, 0.5)',
                    border: '1px solid rgba(248, 113, 113, 0.3)',
                    color: '#fff',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
                <span className="input-helper">
                  Filters out candidates whose company name starts with any of these. e.g. "Oracle"
                  removes "Oracle Japan", "Oracle Corp", etc.
                </span>
              </div>

              <div className="input-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Briefcase size={16} style={{ color: '#60a5fa' }} />
                  Current Role Keywords (comma separated OR)
                </label>
                <input
                  type="text"
                  value={currentRoleKeywords}
                  onChange={(e) => setCurrentRoleKeywords(e.target.value)}
                  placeholder="e.g. Director, Lead, Principal"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: '0.5rem',
                    background: 'rgba(15, 23, 42, 0.5)',
                    border: '1px solid rgba(96, 165, 250, 0.3)',
                    color: '#fff',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
                <span className="input-helper">
                  Filters candidates to only those whose CURRENT role contains ANY of these
                  keywords.
                </span>
              </div>

              {error && (
                <div
                  style={{
                    padding: '1rem',
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#fca5a5',
                    borderRadius: '0.5rem',
                    marginBottom: '1rem',
                  }}
                >
                  {error}
                </div>
              )}

              <div
                className="input-group"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <label>Max Results</label>
                  <input
                    type="number"
                    value={limit}
                    onChange={(e) => setLimit(parseInt(e.target.value) || 25)}
                    min={1}
                    max={200}
                    style={{ width: '100px', padding: '0.5rem' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '1rem', width: '100%' }}>
                  <ExplainableAction
                    label="Full Search (PostgreSQL)"
                    tone="search"
                    icon={<Search size={18} aria-hidden="true" />}
                    loading={loadingState === 'sql'}
                    disabled={loadingState !== 'none'}
                    onClick={() => handleSearch(true)}
                    explanation={
                      <>
                        Uses database full-text search for <strong>100% recall</strong>. Best for
                        exact boolean combinations across all candidates.
                      </>
                    }
                  />

                  <ExplainableAction
                    label="Top Matches (AI Engine)"
                    tone="ml"
                    icon={<Search size={18} aria-hidden="true" />}
                    loading={loadingState === 'meili'}
                    disabled={loadingState !== 'none'}
                    onClick={() => handleSearch(false)}
                    explanation={
                      <>
                        Uses AI search engine. Best for finding the most relevant top matches
                        quickly, but will drop results outside the top 5,000.
                      </>
                    }
                  />
                </div>
              </div>
            </div>
          </motion.div>

          {totalMatches !== null && (
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              <div
                style={{
                  padding: '1rem 1.5rem',
                  background: 'rgba(59, 130, 246, 0.1)',
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                  borderRadius: '1rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <h3 style={{ color: '#93c5fd', margin: 0 }}>Search Results</h3>
                  <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                    <strong>
                      {totalMatches?.toLocaleString()}
                      {totalIsCapped ? '+' : ''}
                    </strong>{' '}
                    {totalIsCapped ? 'or more records match' : 'total records match'} query
                    constraints. Displaying top {results.length}.
                  </span>
                </div>

                {results.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={handleExportCSV}
                      style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        padding: '0.6rem 1.25rem',
                        borderRadius: '0.5rem',
                        fontWeight: 600,
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: '#fff',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <Download size={18} />
                      Export CSV
                    </button>
                    <ExplainableAction
                      label="🎯 Run AI + RL Flight Risk (99% Acc)"
                      tone="ml"
                      onClick={() => {
                        setScreeningEngine('llm');
                        setUsePipeline(false);
                        setIsOutreachModalOpen(true);
                      }}
                      explanation="Uses a combination of AI and Reinforcement Learning models to accurately predict candidate flight risk and job match."
                    />
                    <ExplainableAction
                      label="🚀 Pure AI Semantic Match"
                      tone="ai"
                      onClick={() => {
                        setScreeningEngine('llm');
                        setUsePipeline(true);
                        setIsOutreachModalOpen(true);
                      }}
                      explanation="Uses raw AI prompts to evaluate candidates for role fit without external machine learning heuristics."
                    />
                    <ExplainableAction
                      label="🌳 Tree-Based ML Screening"
                      tone="tree"
                      onClick={() => {
                        setScreeningEngine('tree');
                        setUsePipeline(false);
                        setIsOutreachModalOpen(true);
                      }}
                      explanation="Uses a fast XGBoost ML model to calculate heuristic probability and risk scoring."
                    />
                    <ExplainableAction
                      label="🌳+🤖 Tree + AI Hybrid"
                      tone="hybrid"
                      onClick={() => {
                        setScreeningEngine('tree_llm');
                        setUsePipeline(false);
                        setIsOutreachModalOpen(true);
                      }}
                      explanation="Combines Tree-Based ML scoring for fast filtering with AI-based semantic evaluation for high accuracy."
                    />
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gap: '1rem' }}>
                {results.length === 0 ? (
                  <div
                    className="glass-panel"
                    style={{ textAlign: 'center', padding: '4rem 2rem', opacity: 0.7 }}
                  >
                    <Search size={48} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
                    <h3>No candidates matched exactly.</h3>
                    <p>Try loosening your constraints or checking your NOT exclusions.</p>
                  </div>
                ) : (
                  results.map((hit, idx) => (
                    <CandidateCard key={hit.folder_id} hit={hit} idx={idx} />
                  ))
                )}
              </div>
            </motion.div>
          )}
        </main>

        <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
      `}</style>
      </div>

      <AnimatePresence>
        {isOutreachModalOpen && (
          <Modal
            open={isOutreachModalOpen}
            onClose={() => setIsOutreachModalOpen(false)}
            titleId={outreachTitleId}
            title="Trigger AI Screening"
          >
            <OutreachForm
              jobName={jobName}
              setJobName={setJobName}
              companyName={companyName}
              setCompanyName={setCompanyName}
              adjacentRoles={adjacentRoles}
              setAdjacentRoles={setAdjacentRoles}
              outreachEmail={outreachEmail}
              setOutreachEmail={setOutreachEmail}
              outreachJd={outreachJd}
              setOutreachJd={setOutreachJd}
              isSubmitting={isSubmitting}
              status={outreachStatus}
              onSubmit={handleOutreachSubmit}
              onCancel={() => setIsOutreachModalOpen(false)}
              showAdjacentRoles={screeningEngine === 'llm' || screeningEngine === 'tree_llm'}
            >
              <p
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '0.95rem',
                  marginBottom: '1.5rem',
                  marginTop: 0,
                }}
              >
                {screeningEngine === 'llm'
                  ? `Send all ${totalMatches || 'database'} candidates matching the query to the Outreach Agent. The AI will evaluate each profile deeply against your Job Description and email you the results.`
                  : screeningEngine === 'tree_llm'
                    ? `First, the Pure ML Tree will pre-filter the ${totalMatches || 'database'} candidates. The surviving candidates will then be evaluated deeply by the AI against your Job Description and emailed to you.`
                    : `Send all ${totalMatches || 'database'} candidates matching the query to the Outreach Agent. The Tree-Based ML Model will evaluate each profile deeply against your Job Description and email you the results.`}
              </p>

              {(screeningEngine === 'llm' || screeningEngine === 'tree_llm') && (
                <>
                  <div className="input-group">
                    <label style={{ color: 'var(--text-primary)' }}>
                      AI Provider <span style={{ color: 'var(--danger-fg)' }}>*</span>
                    </label>
                    <select
                      value={selectedProvider}
                      onChange={(e) => {
                        // The model is reconciled by the effect above against
                        // whatever the catalogue actually offers for the new
                        // provider, so no hardcoded id is needed here.
                        setSelectedProvider(e.target.value);
                      }}
                      style={{
                        background: 'var(--surface-input)',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-strong)',
                        width: '100%',
                        outline: 'none',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        marginBottom: '1rem',
                      }}
                    >
                      <option value="deepinfra" style={{ background: 'var(--surface-overlay)' }}>
                        DeepInfra
                      </option>
                      <option value="nvidia" style={{ background: 'var(--surface-overlay)' }}>
                        NVIDIA NIM
                      </option>
                    </select>
                  </div>

                  <div className="input-group">
                    <label style={{ color: 'var(--text-primary)' }}>
                      Analytical Model <span style={{ color: 'var(--danger-fg)' }}>*</span>
                    </label>
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      style={{
                        background: 'var(--surface-input)',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-strong)',
                        width: '100%',
                        outline: 'none',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                    >
                      {providerModels.map((m) => (
                        <option
                          key={m.id}
                          value={m.id}
                          style={{ background: 'var(--surface-overlay)' }}
                        >
                          {m.label}
                          {m.inputPer1M !== null
                            ? ` — $${m.inputPer1M.toFixed(2)}/$${m.outputPer1M?.toFixed(2)} per 1M`
                            : ''}
                          {m.reasoning ? ' · reasoning' : ''}
                        </option>
                      ))}
                    </select>
                    {activeModel && (
                      <span className="input-helper" style={{ marginTop: '0.4rem' }}>
                        {formatCost(activeModel)}
                        {activeModel.contextTokens
                          ? ` · ${Math.round(activeModel.contextTokens / 1000)}k context`
                          : ''}
                        {activeModel.notes ? ` · ${activeModel.notes}` : ''}
                        {modelCatalog.pricesVerifiedOn && activeModel.inputPer1M !== null
                          ? ` · prices checked ${modelCatalog.pricesVerifiedOn}, verify on deepinfra.com/pricing`
                          : ''}
                      </span>
                    )}
                  </div>
                </>
              )}

              <div
                className="input-group"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.5rem',
                }}
              >
                <input
                  type="checkbox"
                  id="bypassDeduplication"
                  checked={bypassDeduplication}
                  onChange={(e) => setBypassDeduplication(e.target.checked)}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <label
                  htmlFor="bypassDeduplication"
                  style={{ color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' }}
                >
                  Force Retry: Ignore submission history and screen everyone again.
                </label>
              </div>

              <div
                className="input-group"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.5rem',
                }}
              >
                <input
                  type="checkbox"
                  id="useCompanyIntel"
                  checked={useCompanyIntel}
                  onChange={(e) => setUseCompanyIntel(e.target.checked)}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <label
                  htmlFor="useCompanyIntel"
                  style={{ color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' }}
                >
                  Use Company Intel: Look up candidate companies in database and attach metadata.
                </label>
              </div>

              {(screeningEngine === 'tree' || screeningEngine === 'tree_llm') && (
                <div
                  className="input-group"
                  style={{
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '1.2rem',
                    marginTop: '0.5rem',
                  }}
                >
                  <label
                    style={{
                      color: 'var(--text-primary)',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <span>🌳</span> ML Tree Settings
                  </label>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1.2rem',
                      background: 'rgba(139, 92, 246, 0.07)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1rem',
                      border: '1px solid rgba(139, 92, 246, 0.2)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <label style={{ color: '#c4b5fd', fontSize: '0.82rem' }}>
                        Select top-K candidates
                      </label>
                      <span style={{ color: '#fff', fontWeight: 700 }}>{treeTopK}</span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={2000}
                      step={10}
                      value={treeTopK}
                      onChange={(e) => setTreeTopK(parseInt(e.target.value))}
                      style={{ width: '100%', accentColor: '#8b5cf6', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}

              {screeningEngine === 'llm' && (
                <div
                  className="input-group"
                  style={{
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '1.2rem',
                    marginTop: '0.5rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <label
                      style={{
                        color: 'var(--text-primary)',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <span>🚀</span> Advanced Pipeline
                    </label>
                    <button
                      type="button"
                      onClick={() => setUsePipeline((p) => !p)}
                      aria-pressed={usePipeline}
                      style={{
                        width: '52px',
                        height: '28px',
                        borderRadius: '14px',
                        border: 'none',
                        background: usePipeline
                          ? 'linear-gradient(135deg, #8b5cf6, #ec4899)'
                          : 'var(--surface-input)',
                        cursor: 'pointer',
                        position: 'relative',
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          top: '4px',
                          left: usePipeline ? '26px' : '4px',
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          background: '#fff',
                          transition: 'left 0.25s',
                        }}
                      />
                    </button>
                  </div>
                  {usePipeline && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1.2rem',
                        background: 'rgba(139, 92, 246, 0.07)',
                        borderRadius: 'var(--radius-md)',
                        padding: '1rem',
                        border: '1px solid rgba(139, 92, 246, 0.2)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ color: '#c4b5fd', fontSize: '0.82rem' }}>
                          Retrieve top-N
                        </label>
                        <span style={{ color: '#fff', fontWeight: 700 }}>{pipelineTopN}</span>
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={1000}
                        step={25}
                        value={pipelineTopN}
                        onChange={(e) => setPipelineTopN(parseInt(e.target.value))}
                        style={{ width: '100%', accentColor: '#8b5cf6', cursor: 'pointer' }}
                      />

                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ color: '#f9a8d4', fontSize: '0.82rem' }}>
                          Rerank to top-K
                        </label>
                        <span style={{ color: '#fff', fontWeight: 700 }}>{pipelineTopK}</span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={500}
                        step={10}
                        value={pipelineTopK}
                        onChange={(e) => setPipelineTopK(parseInt(e.target.value))}
                        style={{ width: '100%', accentColor: '#ec4899', cursor: 'pointer' }}
                      />

                      <div
                        style={{
                          display: 'flex',
                          gap: '1rem',
                          borderTop: '1px solid rgba(139,92,246,0.15)',
                          paddingTop: '1rem',
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <label
                            style={{
                              color: '#c4b5fd',
                              fontSize: '0.82rem',
                              fontWeight: 500,
                              display: 'block',
                              marginBottom: '0.4rem',
                            }}
                          >
                            Min Experience (Years)
                          </label>
                          <input
                            type="number"
                            value={pipelineMinExp}
                            onChange={(e) =>
                              setPipelineMinExp(
                                e.target.value === '' ? '' : parseInt(e.target.value),
                              )
                            }
                            min={0}
                            max={50}
                            placeholder="Auto extract"
                            style={{
                              width: '100%',
                              padding: '0.6rem',
                              borderRadius: '0.5rem',
                              background: 'rgba(15, 23, 42, 0.4)',
                              border: '1px solid rgba(139,92,246,0.3)',
                              color: '#fff',
                              boxSizing: 'border-box',
                              outline: 'none',
                              fontSize: '0.85rem',
                            }}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label
                            style={{
                              color: '#f9a8d4',
                              fontSize: '0.82rem',
                              fontWeight: 500,
                              display: 'block',
                              marginBottom: '0.4rem',
                            }}
                          >
                            Max Experience (Years)
                          </label>
                          <input
                            type="number"
                            value={pipelineMaxExp}
                            onChange={(e) =>
                              setPipelineMaxExp(
                                e.target.value === '' ? '' : parseInt(e.target.value),
                              )
                            }
                            min={0}
                            max={50}
                            placeholder="Auto extract"
                            style={{
                              width: '100%',
                              padding: '0.6rem',
                              borderRadius: '0.5rem',
                              background: 'rgba(15, 23, 42, 0.4)',
                              border: '1px solid rgba(139,92,246,0.3)',
                              color: '#fff',
                              boxSizing: 'border-box',
                              outline: 'none',
                              fontSize: '0.85rem',
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </OutreachForm>
          </Modal>
        )}
      </AnimatePresence>
      <QueueMonitor status={queueInfo} />
    </>
  );
}

export default App;
