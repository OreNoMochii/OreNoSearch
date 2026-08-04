import React, { useState, useEffect, useMemo, useDeferredValue, useId } from 'react';
import {
  Search,
  Loader2,
  Plus,
  X,
  Briefcase,
  MapPin,
      Activity,
  Download,
  Ban,
    Info,
} from 'lucide-react';
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


const API_BASE_URL = '';

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
  const [error, setError] = useState<string | null>(null);
  const [selectedLocations, setSelectedLocations] = useState<string[]>(() => {
    const saved = localStorage.getItem('search_selectedLocations');
    return saved ? JSON.parse(saved) : [];
  });
  const [availableLocations, setAvailableLocations] = useState<string[]>([]);
  const [locationSearch, setLocationSearch] = useState('');
  const outreachTitleId = useId();
  const [hoveredTooltip, setHoveredTooltip] = useState<
    'sql' | 'meili' | 'rl' | 'pure_ai' | 'tree' | 'hybrid' | null
  >(null);

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

  // Persistence effect
  useEffect(() => {
    localStorage.setItem('search_mustNot', mustNot);
    localStorage.setItem('search_andGroups', JSON.stringify(andGroups));
    localStorage.setItem('search_limit', limit.toString());
    localStorage.setItem('search_minExp', minExp.toString());
    localStorage.setItem('search_maxExp', maxExp.toString());
    localStorage.setItem('search_requireOneYear', requireOneYearCurrentRole.toString());
    localStorage.setItem('search_currentRoleKeywords', currentRoleKeywords);
    localStorage.setItem('search_selectedLocations', JSON.stringify(selectedLocations));
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
  const [selectedProvider, setSelectedProvider] = useState('deepinfra');
  const [selectedModel, setSelectedModel] = useState('deepseek-ai/DeepSeek-V3.2');
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

  // Outreach Persistence effect
  React.useEffect(() => {
    localStorage.setItem('outreach_jd', outreachJd);
    localStorage.setItem('outreach_email', outreachEmail);
    localStorage.setItem('outreach_adjacent', adjacentRoles);
    localStorage.setItem('outreach_jobName', jobName);
    localStorage.setItem('outreach_companyName', companyName);
    localStorage.setItem('outreach_engine', screeningEngine);
    localStorage.setItem('outreach_bypassDeduplication', bypassDeduplication.toString());
    localStorage.setItem('outreach_useCompanyIntel', useCompanyIntel.toString());
    localStorage.setItem('outreach_usePipeline', usePipeline.toString());
    localStorage.setItem('outreach_topN', pipelineTopN.toString());
    localStorage.setItem('outreach_topK', pipelineTopK.toString());
    localStorage.setItem('outreach_treeTopK', treeTopK.toString());
    localStorage.setItem('outreach_minExp', pipelineMinExp.toString());
    localStorage.setItem('outreach_maxExp', pipelineMaxExp.toString());
  }, [
    outreachJd,
    outreachEmail,
    screeningEngine,
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
      let submitCandidates: BooleanHit[] = [];

      // If we are using the Advanced Pipeline AND no boolean search was run, we can skip the boolean query.
      // The backend pipeline microservice performs its own hybrid semantic search over the entire vector DB.
      if (!usePipeline || totalMatches !== null) {
        // Re-run boolean query without limit to ensure ALL candidates are dispatched
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
          limit: totalMatches || 100000,
          minExp: minExp === '' ? undefined : minExp,
          maxExp: maxExp === '' ? undefined : maxExp,
          minMonthsInCurrentRole: requireOneYearCurrentRole ? 12 : undefined,
          excludeCompanies: parsedExcludeCompanies.length > 0 ? parsedExcludeCompanies : undefined,
          currentRoleKeywords:
            parsedCurrentRoleKeywords.length > 0 ? parsedCurrentRoleKeywords : undefined,
          locationKeywords: selectedLocations.length > 0 ? selectedLocations : undefined,
        };
        const allCandidatesResp =
          lastSearchMode === 'sql'
            ? await runSqlBooleanSearch(queryParams)
            : await runBooleanSearch(queryParams);
        submitCandidates = allCandidatesResp.hits;
      }

      const response = await fetch(`${API_BASE_URL}/api/outreach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidates: submitCandidates,
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
      setLastSearchMode(useSql ? 'sql' : 'meili');
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : '') || 'An unexpected error occurred');
      setResults([]);
      setTotalMatches(null);
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
          className={totalMatches === null ? "single-column-centered" : "main-grid"}
        >
          <motion.div
            className="glass-panel"
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            <div
              className="input-group"
              style={{
                border: '2px solid rgba(59, 130, 246, 0.5)',
                padding: '1rem',
                borderRadius: '0.75rem',
                background: 'rgba(59, 130, 246, 0.05)',
                marginBottom: '1.5rem',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: '#60a5fa',
                  fontSize: '1.1rem',
                  marginBottom: '1rem',
                }}
              >
                <MapPin size={20} />
                Step 1: Select Target Locations (Required)
              </label>
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.5)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '0.5rem',
                  padding: '0.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                }}
              >
                <input
                  type="text"
                  value={locationSearch}
                  onChange={(e) => setLocationSearch(e.target.value)}
                  placeholder="Search locations..."
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: '0.25rem',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#fff',
                    outline: 'none',
                    fontSize: '0.85rem',
                  }}
                />
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <button
                    type="button"
                    onClick={() => {
                      const matching = visibleLocations;
                      const toAdd = matching.filter((loc) => !selectedLocations.includes(loc));
                      setSelectedLocations([...selectedLocations, ...toAdd]);
                    }}
                    style={{
                      flex: 1,
                      background: 'rgba(59, 130, 246, 0.2)',
                      border: '1px solid rgba(59, 130, 246, 0.3)',
                      color: '#93c5fd',
                      padding: '0.3rem',
                      borderRadius: '0.25rem',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    Check All
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const matching = visibleLocations;
                      setSelectedLocations(
                        selectedLocations.filter((loc) => !matching.includes(loc)),
                      );
                    }}
                    style={{
                      flex: 1,
                      background: 'rgba(239, 68, 68, 0.2)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#fca5a5',
                      padding: '0.3rem',
                      borderRadius: '0.25rem',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    Uncheck All
                  </button>
                </div>
                <div
                  style={{
                    maxHeight: '150px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                  }}
                >
                  {availableLocations.length === 0 && (
                    <div
                      style={{
                        padding: '0.5rem',
                        color: '#94a3b8',
                        fontSize: '0.85rem',
                        fontStyle: 'italic',
                      }}
                    >
                      No locations found. (Loading...)
                    </div>
                  )}
                  {visibleLocations.map((loc) => (
                    <label
                      key={loc}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        cursor: 'pointer',
                        margin: 0,
                        padding: '0.2rem 0.5rem',
                        borderRadius: '0.25rem',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedLocations.includes(loc)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedLocations([...selectedLocations, loc]);
                          } else {
                            setSelectedLocations(selectedLocations.filter((l) => l !== loc));
                          }
                        }}
                        style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                      />
                      <span style={{ color: '#e2e8f0', fontSize: '0.9rem' }}>{loc}</span>
                    </label>
                  ))}
                </div>
                {selectedLocations.length > 0 && (
                  <div
                    style={{
                      marginTop: '0.75rem',
                      paddingTop: '0.5rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 600 }}>
                        Active Location Filters ({selectedLocations.length}):
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedLocations([])}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#fca5a5',
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                        }}
                      >
                        Clear All
                      </button>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.4rem',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        padding: '0.2rem',
                      }}
                    >
                      {selectedLocations.map((loc) => (
                        <div
                          key={loc}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            background: 'rgba(59, 130, 246, 0.2)',
                            border: '1px solid rgba(59, 130, 246, 0.4)',
                            borderRadius: '1rem',
                            padding: '0.2rem 0.65rem 0.2rem 0.4rem',
                            fontSize: '0.8rem',
                            color: '#e2e8f0',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedLocations(selectedLocations.filter((l) => l !== loc))
                            }
                            title={`Remove ${loc}`}
                            style={{
                              background: 'rgba(239, 68, 68, 0.3)',
                              border: 'none',
                              borderRadius: '50%',
                              width: '16px',
                              height: '16px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              padding: 0,
                              color: '#fca5a5',
                            }}
                          >
                            <X size={10} />
                          </button>
                          <span>{loc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <span className="input-helper">
                You must select at least one location before running a search.
              </span>
            </div>

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
                  <div
                    style={{ flex: 1, position: 'relative' }}
                    onMouseEnter={() => setHoveredTooltip('sql')}
                    onMouseLeave={() => setHoveredTooltip(null)}
                  >
                    <button
                      type="button"
                      onClick={() => handleSearch(true)}
                      disabled={loadingState !== 'none'}
                      style={{
                        width: '100%',
                        background: 'linear-gradient(135deg, #10b981, #059669)',
                        padding: '0.75rem',
                        borderRadius: '0.75rem',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        border: 'none',
                        color: '#fff',
                        cursor: loadingState !== 'none' ? 'not-allowed' : 'pointer',
                        opacity: loadingState !== 'none' ? 0.7 : 1,
                        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.2)',
                      }}
                    >
                      {loadingState === 'sql' ? (
                        <Loader2 className="spin" size={18} />
                      ) : (
                        <Search size={18} />
                      )}
                      Full Search (PostgreSQL)
                      <span
                        style={{
                          fontSize: '0.75rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.2rem',
                          background: 'rgba(0,0,0,0.2)',
                          padding: '0.15rem 0.4rem',
                          borderRadius: '1rem',
                          marginLeft: '0.25rem',
                        }}
                      >
                        <Info size={12} /> Explain
                      </span>
                    </button>
                    <AnimatePresence>
                      {hoveredTooltip === 'sql' && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 10 }}
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: '0',
                            right: '0',
                            marginTop: '0.5rem',
                            background: '#1e293b',
                            border: '1px solid rgba(255,255,255,0.1)',
                            padding: '0.75rem',
                            borderRadius: '0.5rem',
                            color: '#e2e8f0',
                            fontSize: '0.85rem',
                            zIndex: 50,
                            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                          }}
                        >
                          Uses database full-text search for <strong>100% recall</strong>. Best for
                          exact boolean combinations across all candidates.
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div
                    style={{ flex: 1, position: 'relative' }}
                    onMouseEnter={() => setHoveredTooltip('meili')}
                    onMouseLeave={() => setHoveredTooltip(null)}
                  >
                    <button
                      type="button"
                      onClick={() => handleSearch(false)}
                      disabled={loadingState !== 'none'}
                      style={{
                        width: '100%',
                        background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                        padding: '0.75rem',
                        borderRadius: '0.75rem',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        border: 'none',
                        color: '#fff',
                        cursor: loadingState !== 'none' ? 'not-allowed' : 'pointer',
                        opacity: loadingState !== 'none' ? 0.7 : 1,
                        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.2)',
                      }}
                    >
                      {loadingState === 'meili' ? (
                        <Loader2 className="spin" size={18} />
                      ) : (
                        <Activity size={18} />
                      )}
                      Top Results (Meilisearch)
                      <span
                        style={{
                          fontSize: '0.75rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.2rem',
                          background: 'rgba(0,0,0,0.2)',
                          padding: '0.15rem 0.4rem',
                          borderRadius: '1rem',
                          marginLeft: '0.25rem',
                        }}
                      >
                        <Info size={12} /> Explain
                      </span>
                    </button>
                    <AnimatePresence>
                      {hoveredTooltip === 'meili' && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 10 }}
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: '0',
                            right: '0',
                            marginTop: '0.5rem',
                            background: '#1e293b',
                            border: '1px solid rgba(255,255,255,0.1)',
                            padding: '0.75rem',
                            borderRadius: '0.5rem',
                            color: '#e2e8f0',
                            fontSize: '0.85rem',
                            zIndex: 50,
                            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                          }}
                        >
                          Uses AI search engine. Best for finding the most relevant top matches
                          quickly, but will drop results outside the top 5,000.
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
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
                    <strong>{totalMatches}</strong> total records match query constraints.
                    Displaying top {results.length}.
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
                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredTooltip('rl')}
                      onMouseLeave={() => setHoveredTooltip(null)}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setScreeningEngine('llm');
                          setUsePipeline(false);
                          setIsOutreachModalOpen(true);
                        }}
                        style={{
                          background: 'linear-gradient(135deg, #10b981, #059669)',
                          padding: '0.6rem 1.25rem',
                          borderRadius: '0.5rem',
                          fontWeight: 600,
                          border: 'none',
                          color: '#fff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                        }}
                      >
                        🎯 Run AI + RL Flight Risk (99% Acc)
                        <span
                          style={{
                            fontSize: '0.75rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.2rem',
                            background: 'rgba(0,0,0,0.2)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '1rem',
                            marginLeft: '0.25rem',
                          }}
                        >
                          <Info size={12} /> Explain
                        </span>
                      </button>
                      <AnimatePresence>
                        {hoveredTooltip === 'rl' && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            style={{
                              position: 'absolute',
                              bottom: '100%',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              marginBottom: '0.5rem',
                              background: '#1e293b',
                              border: '1px solid rgba(255,255,255,0.1)',
                              padding: '0.75rem',
                              borderRadius: '0.5rem',
                              color: '#e2e8f0',
                              fontSize: '0.85rem',
                              zIndex: 50,
                              minWidth: '250px',
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                            }}
                          >
                            Uses a combination of AI and Reinforcement Learning models to accurately
                            predict candidate flight risk and job match.
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredTooltip('pure_ai')}
                      onMouseLeave={() => setHoveredTooltip(null)}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setScreeningEngine('llm');
                          setUsePipeline(true);
                          setIsOutreachModalOpen(true);
                        }}
                        style={{
                          background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                          padding: '0.6rem 1.25rem',
                          borderRadius: '0.5rem',
                          fontWeight: 600,
                          border: 'none',
                          color: '#fff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                        }}
                      >
                        🚀 Pure AI Semantic Match
                        <span
                          style={{
                            fontSize: '0.75rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.2rem',
                            background: 'rgba(0,0,0,0.2)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '1rem',
                            marginLeft: '0.25rem',
                          }}
                        >
                          <Info size={12} /> Explain
                        </span>
                      </button>
                      <AnimatePresence>
                        {hoveredTooltip === 'pure_ai' && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            style={{
                              position: 'absolute',
                              bottom: '100%',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              marginBottom: '0.5rem',
                              background: '#1e293b',
                              border: '1px solid rgba(255,255,255,0.1)',
                              padding: '0.75rem',
                              borderRadius: '0.5rem',
                              color: '#e2e8f0',
                              fontSize: '0.85rem',
                              zIndex: 50,
                              minWidth: '250px',
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                            }}
                          >
                            Uses raw AI prompts to evaluate candidates for role fit without external
                            machine learning heuristics.
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredTooltip('tree')}
                      onMouseLeave={() => setHoveredTooltip(null)}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setScreeningEngine('tree');
                          setUsePipeline(false);
                          setIsOutreachModalOpen(true);
                        }}
                        style={{
                          background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
                          padding: '0.6rem 1.25rem',
                          borderRadius: '0.5rem',
                          fontWeight: 600,
                          border: 'none',
                          color: '#fff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                        }}
                      >
                        🌳 Tree-Based ML Screening
                        <span
                          style={{
                            fontSize: '0.75rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.2rem',
                            background: 'rgba(0,0,0,0.2)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '1rem',
                            marginLeft: '0.25rem',
                          }}
                        >
                          <Info size={12} /> Explain
                        </span>
                      </button>
                      <AnimatePresence>
                        {hoveredTooltip === 'tree' && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            style={{
                              position: 'absolute',
                              bottom: '100%',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              marginBottom: '0.5rem',
                              background: '#1e293b',
                              border: '1px solid rgba(255,255,255,0.1)',
                              padding: '0.75rem',
                              borderRadius: '0.5rem',
                              color: '#e2e8f0',
                              fontSize: '0.85rem',
                              zIndex: 50,
                              minWidth: '250px',
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                            }}
                          >
                            Uses a fast XGBoost ML model to calculate heuristic probability and risk
                            scoring.
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredTooltip('hybrid')}
                      onMouseLeave={() => setHoveredTooltip(null)}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setScreeningEngine('tree_llm');
                          setUsePipeline(false);
                          setIsOutreachModalOpen(true);
                        }}
                        style={{
                          background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                          padding: '0.6rem 1.25rem',
                          borderRadius: '0.5rem',
                          fontWeight: 600,
                          border: 'none',
                          color: '#fff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                        }}
                      >
                        🌳+🤖 Tree + AI Hybrid
                        <span
                          style={{
                            fontSize: '0.75rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.2rem',
                            background: 'rgba(0,0,0,0.2)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '1rem',
                            marginLeft: '0.25rem',
                          }}
                        >
                          <Info size={12} /> Explain
                        </span>
                      </button>
                      <AnimatePresence>
                        {hoveredTooltip === 'hybrid' && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            style={{
                              position: 'absolute',
                              bottom: '100%',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              marginBottom: '0.5rem',
                              background: '#1e293b',
                              border: '1px solid rgba(255,255,255,0.1)',
                              padding: '0.75rem',
                              borderRadius: '0.5rem',
                              color: '#e2e8f0',
                              fontSize: '0.85rem',
                              zIndex: 50,
                              minWidth: '250px',
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                            }}
                          >
                            Combines Tree-Based ML scoring for fast filtering with AI-based semantic
                            evaluation for high accuracy.
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
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
                        const newProv = e.target.value;
                        setSelectedProvider(newProv);
                        if (newProv === 'nvidia') {
                          setSelectedModel('nvidia:meta/llama-3.1-70b-instruct');
                        } else {
                          setSelectedModel('deepseek-ai/DeepSeek-V3.2');
                        }
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
                      <option value="deepinfra" style={{ background: 'var(--surface-overlay)' }}>DeepInfra</option>
                      <option value="nvidia" style={{ background: 'var(--surface-overlay)' }}>NVIDIA NIM</option>
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
                      {selectedProvider === 'deepinfra' && (
                        <>
                          <option value="deepseek-ai/DeepSeek-V3.2" style={{ background: 'var(--surface-overlay)' }}>DeepSeek V3.2</option>
                          <option value="deepseek-ai/DeepSeek-R1" style={{ background: 'var(--surface-overlay)' }}>DeepSeek R1</option>
                        </>
                      )}
                      {selectedProvider === 'nvidia' && (
                        <>
                          <option value="nvidia:meta/llama-3.1-70b-instruct" style={{ background: 'var(--surface-overlay)' }}>NVIDIA NIM: Llama 3.1 70B</option>
                          <option value="nvidia:meta/llama-3.1-405b-instruct" style={{ background: 'var(--surface-overlay)' }}>NVIDIA NIM: Llama 3.1 405B</option>
                        </>
                      )}
                    </select>
                  </div>
                </>
              )}

              <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="bypassDeduplication"
                  checked={bypassDeduplication}
                  onChange={(e) => setBypassDeduplication(e.target.checked)}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <label htmlFor="bypassDeduplication" style={{ color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' }}>
                  Force Retry: Ignore submission history and screen everyone again.
                </label>
              </div>

              <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="useCompanyIntel"
                  checked={useCompanyIntel}
                  onChange={(e) => setUseCompanyIntel(e.target.checked)}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <label htmlFor="useCompanyIntel" style={{ color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' }}>
                  Use Company Intel: Look up candidate companies in database and attach metadata.
                </label>
              </div>

              {(screeningEngine === 'tree' || screeningEngine === 'tree_llm') && (
                <div className="input-group" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '1.2rem', marginTop: '0.5rem' }}>
                  <label style={{ color: 'var(--text-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span>🌳</span> ML Tree Settings
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', background: 'rgba(139, 92, 246, 0.07)', borderRadius: 'var(--radius-md)', padding: '1rem', border: '1px solid rgba(139, 92, 246, 0.2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <label style={{ color: '#c4b5fd', fontSize: '0.82rem' }}>Select top-K candidates</label>
                      <span style={{ color: '#fff', fontWeight: 700 }}>{treeTopK}</span>
                    </div>
                    <input type="range" min={10} max={2000} step={10} value={treeTopK} onChange={(e) => setTreeTopK(parseInt(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6', cursor: 'pointer' }} />
                  </div>
                </div>
              )}

              {screeningEngine === 'llm' && (
                <div className="input-group" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '1.2rem', marginTop: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <label style={{ color: 'var(--text-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span>🚀</span> Advanced Pipeline
                    </label>
                    <button type="button" onClick={() => setUsePipeline((p) => !p)} aria-pressed={usePipeline} style={{ width: '52px', height: '28px', borderRadius: '14px', border: 'none', background: usePipeline ? 'linear-gradient(135deg, #8b5cf6, #ec4899)' : 'var(--surface-input)', cursor: 'pointer', position: 'relative' }}>
                      <span style={{ position: 'absolute', top: '4px', left: usePipeline ? '26px' : '4px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.25s' }} />
                    </button>
                  </div>
                  {usePipeline && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', background: 'rgba(139, 92, 246, 0.07)', borderRadius: 'var(--radius-md)', padding: '1rem', border: '1px solid rgba(139, 92, 246, 0.2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ color: '#c4b5fd', fontSize: '0.82rem' }}>Retrieve top-N</label>
                        <span style={{ color: '#fff', fontWeight: 700 }}>{pipelineTopN}</span>
                      </div>
                      <input type="range" min={50} max={1000} step={25} value={pipelineTopN} onChange={(e) => setPipelineTopN(parseInt(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6', cursor: 'pointer' }} />

                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ color: '#f9a8d4', fontSize: '0.82rem' }}>Rerank to top-K</label>
                        <span style={{ color: '#fff', fontWeight: 700 }}>{pipelineTopK}</span>
                      </div>
                      <input type="range" min={10} max={500} step={10} value={pipelineTopK} onChange={(e) => setPipelineTopK(parseInt(e.target.value))} style={{ width: '100%', accentColor: '#ec4899', cursor: 'pointer' }} />
                      
                      <div style={{ display: 'flex', gap: '1rem', borderTop: '1px solid rgba(139,92,246,0.15)', paddingTop: '1rem' }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ color: '#c4b5fd', fontSize: '0.82rem', fontWeight: 500, display: 'block', marginBottom: '0.4rem' }}>
                            Min Experience (Years)
                          </label>
                          <input type="number" value={pipelineMinExp} onChange={(e) => setPipelineMinExp(e.target.value === '' ? '' : parseInt(e.target.value))} min={0} max={50} placeholder="Auto extract" style={{ width: '100%', padding: '0.6rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.4)', border: '1px solid rgba(139,92,246,0.3)', color: '#fff', boxSizing: 'border-box', outline: 'none', fontSize: '0.85rem' }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ color: '#f9a8d4', fontSize: '0.82rem', fontWeight: 500, display: 'block', marginBottom: '0.4rem' }}>
                            Max Experience (Years)
                          </label>
                          <input type="number" value={pipelineMaxExp} onChange={(e) => setPipelineMaxExp(e.target.value === '' ? '' : parseInt(e.target.value))} min={0} max={50} placeholder="Auto extract" style={{ width: '100%', padding: '0.6rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.4)', border: '1px solid rgba(139,92,246,0.3)', color: '#fff', boxSizing: 'border-box', outline: 'none', fontSize: '0.85rem' }} />
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
