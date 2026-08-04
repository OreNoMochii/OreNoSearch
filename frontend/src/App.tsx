import React, { useState, useEffect } from 'react';
import { Search, Loader2, Plus, X, Briefcase, MapPin, Building2, FileText, Activity, Clock, Download, Ban, GraduationCap, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { runBooleanSearch, getAvailableLocations, type BooleanHit, runSqlBooleanSearch } from './searchClient';
import { motion, AnimatePresence } from 'framer-motion';

const API_BASE_URL = '';

// --- Queue Monitor Component ---
interface QueueStatus {
  activeCount: number;
  maxConcurrent: number;
  pendingCount: number;
  activeBatches: { id: number; size: number; processed: number; owner: string }[];
  queuedBatches: { id: number; size: number; owner: string }[];
}

function QueueMonitor({ status }: { status: QueueStatus | null }) {
  if (!status || (status.activeCount === 0 && status.pendingCount === 0)) return null;

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      style={{
        position: 'fixed',
        bottom: '2rem',
        right: '2rem',
        zIndex: 900,
        background: '#1e293b',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '1rem',
        padding: '1rem',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
        minWidth: '280px',
        backdropFilter: 'blur(10px)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '0.5rem' }}>
        <Activity size={18} className="text-blue-400" style={{ color: '#60a5fa' }} />
        <span style={{ fontWeight: 600, color: '#f8fafc', fontSize: '0.9rem' }}>AI Screening Engine</span>
      </div>

      {status.activeBatches.map(batch => (
        <div key={batch.id} style={{ marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.4rem' }}>
            <span style={{ color: '#6ee7b7' }}>● Batch #{batch.id} ({batch.owner})</span>
            <span>{batch.processed || 0} / {batch.size}</span>
          </div>
          <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(batch.processed / batch.size) * 100}%` }}
              transition={{ duration: 0.5 }}
              style={{ height: '100%', background: '#10b981' }}
            />
          </div>
        </div>
      ))}

      {status.pendingCount > 0 && (
        <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#94a3b8', fontSize: '0.8rem' }}>
            <Clock size={14} />
            <span>{status.pendingCount} Batch{status.pendingCount > 1 ? 'es' : ''} in Queue</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '0.5rem' }}>
            {status.queuedBatches.map(b => (
              <div key={b.id} style={{ background: 'rgba(255,255,255,0.1)', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.05)' }}>
                #{b.id} ({b.owner})
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function ExpandableSummary({ text, maxLength = 150 }: { text: string; maxLength?: number }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > maxLength;
  const displayText = expanded || !needsTruncation ? text : text.substring(0, maxLength).trimEnd() + '…';

  return (
    <div>
      <div style={{ fontWeight: 500, fontSize: '0.85rem', lineHeight: '1.5', whiteSpace: 'pre-line' }}>{displayText}</div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'none',
            border: 'none',
            color: '#60a5fa',
            cursor: 'pointer',
            padding: '0.25rem 0',
            fontSize: '0.8rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            marginTop: '0.25rem'
          }}
        >
          {expanded ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Read more</>}
        </button>
      )}
    </div>
  );
}

function App() {
  const [mustNot, setMustNot] = useState(() => localStorage.getItem('search_mustNot') || '');
  const [andGroups, setAndGroups] = useState<string[]>(() => {
    const saved = localStorage.getItem('search_andGroups');
    return saved ? JSON.parse(saved) : [];
  });
  const [limit, setLimit] = useState<number>(() => Number(localStorage.getItem('search_limit')) || 25);
  const [minExp, setMinExp] = useState<number | ''>(() => {
    const saved = localStorage.getItem('search_minExp');
    return saved ? Number(saved) : '';
  });
  const [maxExp, setMaxExp] = useState<number | ''>(() => {
    const saved = localStorage.getItem('search_maxExp');
    return saved ? Number(saved) : '';
  });
  const [requireOneYearCurrentRole, setRequireOneYearCurrentRole] = useState(() => localStorage.getItem('search_requireOneYear') === 'true');
  const [excludeCompanies, setExcludeCompanies] = useState(() => localStorage.getItem('search_excludeCompanies') || '');
  const [currentRoleKeywords, setCurrentRoleKeywords] = useState(() => localStorage.getItem('search_currentRoleKeywords') || '');

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
  const [hoveredTooltip, setHoveredTooltip] = useState<'sql' | 'meili' | 'rl' | 'pure_ai' | 'tree' | 'hybrid' | null>(null);

  // Fetch available locations on mount
  useEffect(() => {
    getAvailableLocations().then(locs => {
      setAvailableLocations(locs);
    }).catch(console.error);
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
  }, [mustNot, andGroups, limit, minExp, maxExp, requireOneYearCurrentRole, excludeCompanies, currentRoleKeywords, selectedLocations]);

  // Outreach Modal State
  const [isOutreachModalOpen, setIsOutreachModalOpen] = useState(false);
  const [outreachJd, setOutreachJd] = useState(() => localStorage.getItem('outreach_jd') || '');
  const [outreachEmail, setOutreachEmail] = useState(() => localStorage.getItem('outreach_email') || '');
  const [screeningEngine, setScreeningEngine] = useState(() => localStorage.getItem('outreach_engine') || 'llm');
  const [selectedProvider, setSelectedProvider] = useState('deepinfra');
  const [selectedModel, setSelectedModel] = useState('deepseek-ai/DeepSeek-V3.2');
  const [adjacentRoles, setAdjacentRoles] = useState(() => localStorage.getItem('outreach_adjacent') || '');
  const [jobName, setJobName] = useState(() => localStorage.getItem('outreach_jobName') || '');
  const [companyName, setCompanyName] = useState(() => localStorage.getItem('outreach_companyName') || '');
  const [bypassDeduplication, setBypassDeduplication] = useState(() => localStorage.getItem('outreach_bypassDeduplication') === 'true');
  const [useCompanyIntel, setUseCompanyIntel] = useState(() => localStorage.getItem('outreach_useCompanyIntel') !== 'false');
  const [usePipeline, setUsePipeline] = useState(() => localStorage.getItem('outreach_usePipeline') === 'true');
  const [pipelineTopN, setPipelineTopN] = useState(() => parseInt(localStorage.getItem('outreach_topN') || '700'));
  const [pipelineTopK, setPipelineTopK] = useState(() => parseInt(localStorage.getItem('outreach_topK') || '300'));
  const [treeTopK, setTreeTopK] = useState(() => parseInt(localStorage.getItem('outreach_treeTopK') || '1000'));

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
  const [queueInfo, setQueueInfo] = useState<QueueStatus | null>(null);

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
  }, [outreachJd, outreachEmail, screeningEngine, adjacentRoles, jobName, companyName, bypassDeduplication, useCompanyIntel, usePipeline, pipelineTopN, pipelineTopK, treeTopK, pipelineMinExp, pipelineMaxExp]);

  // Poll queue status
  React.useEffect(() => {
    const fetchStatus = async () => {
      try {
        const resp = await fetch(`${API_BASE_URL}/api/queue-status`);
        if (resp.ok) {
          const data = await resp.json();
          setQueueInfo(data);
        }
      } catch (e) {
        console.error("Queue poll failed", e);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleExportCSV = () => {
    if (results.length === 0) return;

    const headers = ['Name', 'Headline/Role', 'Company', 'Tenure', 'Move Prob', 'Hazard', 'Profile URL', 'Location', 'Contacted By', 'Shared With', 'Data Added'];
    const csvContent = [
      headers.join(','),
      ...results.map(h => {
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
          ''  // Data Added
        ];
        return row.map(val => `"${val.toString().replace(/"/g, '""')}"`).join(',');
      })
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeTitle = jobName ? jobName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() : 'candidates';
    link.setAttribute('download', `${safeTitle}_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleOutreachSubmit = async () => {
    if (!outreachJd || !outreachEmail || !jobName || !companyName) {
      setOutreachStatus("Please provide all required fields (Job Name, Company, JD, and Email).");
      return;
    }
    setIsSubmitting(true);
    setOutreachStatus(null);
    try {
      let submitCandidates: any[] = [];
      
      // If we are using the Advanced Pipeline AND no boolean search was run, we can skip the boolean query.
      // The backend pipeline microservice performs its own hybrid semantic search over the entire vector DB.
      if (!usePipeline || totalMatches !== null) {
        // Re-run boolean query without limit to ensure ALL candidates are dispatched
        const parsedExcludeCompanies = excludeCompanies.split(',').map(s => s.trim()).filter(Boolean);
        const parsedCurrentRoleKeywords = currentRoleKeywords.split(',').map(s => s.trim()).filter(Boolean);
        const queryParams = {
          should: [],
          must: [],
          mustNot: mustNot.split(/,|\bOR\b|\|/i).map(s => s.trim()).filter(Boolean),
          andGroups: andGroups.map(g => g.split(/,|\bOR\b|\|/i).map(s => s.trim()).filter(Boolean)).filter(g => g.length > 0),
          limit: totalMatches || 100000,
          minExp: minExp === '' ? undefined : minExp,
          maxExp: maxExp === '' ? undefined : maxExp,
          minMonthsInCurrentRole: requireOneYearCurrentRole ? 12 : undefined,
          excludeCompanies: parsedExcludeCompanies.length > 0 ? parsedExcludeCompanies : undefined,
          currentRoleKeywords: parsedCurrentRoleKeywords.length > 0 ? parsedCurrentRoleKeywords : undefined,
          locationKeywords: selectedLocations.length > 0 ? selectedLocations : undefined
        };
        const allCandidatesResp = lastSearchMode === 'sql' 
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
          model: (screeningEngine === 'llm' || screeningEngine === 'tree_llm') ? selectedModel : undefined,
          adjacentRoles: (screeningEngine === 'llm' || screeningEngine === 'tree_llm') ? adjacentRoles : undefined,
          jobName: jobName,
          companyName: companyName,
          bypassDeduplication: bypassDeduplication,
          useCompanyIntel: useCompanyIntel,
          usePipeline: (screeningEngine === 'tree' || screeningEngine === 'tree_llm') ? false : usePipeline,
          screeningEngine: screeningEngine,
          topN: (screeningEngine === 'llm' || screeningEngine === 'tree_llm') ? pipelineTopN : undefined,
          topK: (screeningEngine === 'llm' || screeningEngine === 'tree_llm') ? pipelineTopK : undefined,
          treeTopK: (screeningEngine === 'tree' || screeningEngine === 'tree_llm') ? treeTopK : undefined,
          minExp: (screeningEngine === 'llm' || screeningEngine === 'tree_llm') ? (pipelineMinExp === '' ? undefined : pipelineMinExp) : undefined,
          maxExp: (screeningEngine === 'llm' || screeningEngine === 'tree_llm') ? (pipelineMaxExp === '' ? undefined : pipelineMaxExp) : undefined,

        })
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
    } catch (err: any) {
      setOutreachStatus(err.message || 'Network error connecting to AI agent API.');
      setIsSubmitting(false); // Re-enable on error so user can fix and try again
    }
  };

  const handleSearch = async (useSql: boolean) => {
    if (selectedLocations.length === 0) {
      setError("Please select at least one location before searching.");
      return;
    }
    setError(null);
    setLoadingState(useSql ? 'sql' : 'meili');
    try {
      const parsedExcludeCompanies = excludeCompanies.split(',').map(s => s.trim()).filter(Boolean);
      const parsedCurrentRoleKeywords = currentRoleKeywords.split(',').map(s => s.trim()).filter(Boolean);
      
      const queryParams = {
        should: [],
        must: [],
        mustNot: mustNot.split(/,|\bOR\b|\|/i).map(s => s.trim()).filter(Boolean),
        andGroups: andGroups.map(g => g.split(/,|\bOR\b|\|/i).map(s => s.trim()).filter(Boolean)).filter(g => g.length > 0),
        limit,
        minExp: minExp === '' ? undefined : minExp,
        maxExp: maxExp === '' ? undefined : maxExp,
        minMonthsInCurrentRole: requireOneYearCurrentRole ? 12 : undefined,
        excludeCompanies: parsedExcludeCompanies.length > 0 ? parsedExcludeCompanies : undefined,
        currentRoleKeywords: parsedCurrentRoleKeywords.length > 0 ? parsedCurrentRoleKeywords : undefined,
        locationKeywords: selectedLocations.length > 0 ? selectedLocations : undefined
      };

      const resp = useSql ? await runSqlBooleanSearch(queryParams) : await runBooleanSearch(queryParams);
      
      setResults(resp.hits);

      setTotalMatches(resp.total);
      setLastSearchMode(useSql ? 'sql' : 'meili');
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred");
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
      <div className="app-container animate-slide-up">
        <header className="header">
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.5 }}>
            <h1>Deep Search</h1>
            <p>Deploy ultra-precise boolean filters to pinpoint the exact candidate profiles you need.</p>
          </motion.div>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
          <motion.div
            className="glass-panel"
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
              <div className="input-group" style={{ 
                border: '2px solid rgba(59, 130, 246, 0.5)', 
                padding: '1rem', 
                borderRadius: '0.75rem',
                background: 'rgba(59, 130, 246, 0.05)',
                marginBottom: '1.5rem'
              }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#60a5fa', fontSize: '1.1rem', marginBottom: '1rem' }}>
                <MapPin size={20} />
                Step 1: Select Target Locations (Required)
              </label>
              <div style={{
                background: 'rgba(15, 23, 42, 0.5)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '0.5rem',
                padding: '0.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.4rem'
              }}>
                <input
                  type="text"
                  value={locationSearch}
                  onChange={e => setLocationSearch(e.target.value)}
                  placeholder="Search locations..."
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: '0.25rem',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#fff',
                    outline: 'none',
                    fontSize: '0.85rem'
                  }}
                />
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <button
                    onClick={() => {
                      const matching = availableLocations.filter(loc => loc.toLowerCase().includes(locationSearch.toLowerCase()));
                      const toAdd = matching.filter(loc => !selectedLocations.includes(loc));
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
                      cursor: 'pointer'
                    }}
                  >Check All</button>
                  <button
                    onClick={() => {
                      const matching = availableLocations.filter(loc => loc.toLowerCase().includes(locationSearch.toLowerCase()));
                      setSelectedLocations(selectedLocations.filter(loc => !matching.includes(loc)));
                    }}
                    style={{
                      flex: 1,
                      background: 'rgba(239, 68, 68, 0.2)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#fca5a5',
                      padding: '0.3rem',
                      borderRadius: '0.25rem',
                      fontSize: '0.8rem',
                      cursor: 'pointer'
                    }}
                  >Uncheck All</button>
                </div>
                <div style={{
                  maxHeight: '150px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem'
                }}>
                  {availableLocations.length === 0 && (
                     <div style={{ padding: '0.5rem', color: '#94a3b8', fontSize: '0.85rem', fontStyle: 'italic' }}>
                       No locations found. (Loading...)
                     </div>
                  )}
                  {availableLocations.filter(loc => loc.toLowerCase().includes(locationSearch.toLowerCase())).map(loc => (
                    <label key={loc} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', margin: 0, padding: '0.2rem 0.5rem', borderRadius: '0.25rem' }}>
                      <input 
                        type="checkbox"
                        checked={selectedLocations.includes(loc)}
                        onChange={e => {
                          if (e.target.checked) {
                            setSelectedLocations([...selectedLocations, loc]);
                          } else {
                            setSelectedLocations(selectedLocations.filter(l => l !== loc));
                          }
                        }}
                        style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                      />
                      <span style={{ color: '#e2e8f0', fontSize: '0.9rem' }}>{loc}</span>
                    </label>
                  ))}
                </div>
                {selectedLocations.length > 0 && (
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 600 }}>
                        Active Location Filters ({selectedLocations.length}):
                      </span>
                      <button
                        onClick={() => setSelectedLocations([])}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#fca5a5',
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0
                        }}
                      >
                        Clear All
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: '120px', overflowY: 'auto', padding: '0.2rem' }}>
                      {selectedLocations.map(loc => (
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
                            color: '#e2e8f0'
                          }}
                        >
                          <button
                            onClick={() => setSelectedLocations(selectedLocations.filter(l => l !== loc))}
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
                              color: '#fca5a5'
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
              <span className="input-helper">You must select at least one location before running a search.</span>
            </div>

            <div style={{ opacity: selectedLocations.length === 0 ? 0.5 : 1 }}>
              <h2 style={{ fontSize: '1.1rem', color: '#cbd5e1', marginBottom: '1rem', paddingBottom: '0.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>Step 2: Boolean Parameters</h2>
              
            <div className="input-group">
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>AND Groups (Parenthetical ORs)</span>
                <button
                  onClick={addGroup}
                  style={{
                    background: 'rgba(59, 130, 246, 0.2)', padding: '0.4rem 0.8rem',
                    borderRadius: '0.5rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', border: '1px solid rgba(59, 130, 246, 0.4)'
                  }}
                >
                  <Plus size={14} /> Add Group
                </button>
              </label>
              <span className="input-helper" style={{ marginBottom: '0.5rem' }}>Each box is an internal OR. All separate boxes are ANDed together.</span>

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
                      onChange={e => updateGroup(i, e.target.value)}
                      rows={2}
                      placeholder="group terms separated by commas..."
                      style={{ paddingRight: '3rem', background: 'rgba(30, 64, 175, 0.15)', borderColor: 'rgba(59, 130, 246, 0.3)' }}
                    />
                    <button
                      onClick={() => removeGroup(i)}
                      style={{
                        position: 'absolute', top: '0.75rem', right: '0.75rem',
                        background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444',
                        border: 'none', borderRadius: '50%', padding: '0.4rem', cursor: 'pointer'
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
                onChange={e => setMustNot(e.target.value)}
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
                  onChange={e => setMinExp(e.target.value === '' ? '' : parseInt(e.target.value))}
                  min={0} max={50}
                  placeholder="0"
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.5)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label>Max Experience (Years)</label>
                <input
                  type="number"
                  value={maxExp}
                  onChange={e => setMaxExp(e.target.value === '' ? '' : parseInt(e.target.value))}
                  min={0} max={50}
                  placeholder="50+"
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.5)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
            </div>

            <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                id="requireOneYearCurrentRole"
                checked={requireOneYearCurrentRole}
                onChange={e => setRequireOneYearCurrentRole(e.target.checked)}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label htmlFor="requireOneYearCurrentRole" style={{ color: '#cbd5e1', cursor: 'pointer', fontSize: '0.9rem', margin: 0 }}>
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
                onChange={e => setExcludeCompanies(e.target.value)}
                placeholder="e.g. Google, Amazon, Rakuten"
                style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.5)', border: '1px solid rgba(248, 113, 113, 0.3)', color: '#fff', boxSizing: 'border-box', outline: 'none' }}
              />
              <span className="input-helper">Filters out candidates whose company name starts with any of these. e.g. "Oracle" removes "Oracle Japan", "Oracle Corp", etc.</span>
            </div>

            <div className="input-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Briefcase size={16} style={{ color: '#60a5fa' }} />
                Current Role Keywords (comma separated OR)
              </label>
              <input
                type="text"
                value={currentRoleKeywords}
                onChange={e => setCurrentRoleKeywords(e.target.value)}
                placeholder="e.g. Director, Lead, Principal"
                style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.5)', border: '1px solid rgba(96, 165, 250, 0.3)', color: '#fff', boxSizing: 'border-box', outline: 'none' }}
              />
              <span className="input-helper">Filters candidates to only those whose CURRENT role contains ANY of these keywords.</span>
            </div>




            {error && (
              <div style={{ padding: '1rem', background: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5', borderRadius: '0.5rem', marginBottom: '1rem' }}>
                {error}
              </div>
            )}

            <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <label>Max Results</label>
                <input
                  type="number"
                  value={limit}
                  onChange={e => setLimit(parseInt(e.target.value) || 25)}
                  min={1} max={200}
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
                      boxShadow: '0 4px 6px -1px rgba(0,0,0,0.2)'
                    }}
                  >
                    {loadingState === 'sql' ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                    Full Search (PostgreSQL)
                    <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'rgba(0,0,0,0.2)', padding: '0.15rem 0.4rem', borderRadius: '1rem', marginLeft: '0.25rem' }}>
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
                          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
                        }}
                      >
                        Uses database full-text search for <strong>100% recall</strong>. Best for exact boolean combinations across all candidates.
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
                      boxShadow: '0 4px 6px -1px rgba(0,0,0,0.2)'
                    }}
                  >
                    {loadingState === 'meili' ? <Loader2 className="spin" size={18} /> : <Activity size={18} />}
                    Top Results (Meilisearch)
                    <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'rgba(0,0,0,0.2)', padding: '0.15rem 0.4rem', borderRadius: '1rem', marginLeft: '0.25rem' }}>
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
                          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
                        }}
                      >
                        Uses AI search engine. Best for finding the most relevant top matches quickly, but will drop results outside the top 5,000.
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
              <div style={{ padding: '1rem 1.5rem', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <h3 style={{ color: '#93c5fd', margin: 0 }}>Search Results</h3>
                  <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                    <strong>{totalMatches}</strong> total records match query constraints. Displaying top {results.length}.
                  </span>
                </div>

                {results.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <button
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
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                        }}
                      >
                        🎯 Run AI + RL Flight Risk (99% Acc)
                        <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'rgba(0,0,0,0.2)', padding: '0.15rem 0.4rem', borderRadius: '1rem', marginLeft: '0.25rem' }}>
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
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
                            }}
                          >
                            Uses a combination of AI and Reinforcement Learning models to accurately predict candidate flight risk and job match.
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
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                        }}
                      >
                        🚀 Pure AI Semantic Match
                        <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'rgba(0,0,0,0.2)', padding: '0.15rem 0.4rem', borderRadius: '1rem', marginLeft: '0.25rem' }}>
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
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
                            }}
                          >
                            Uses raw AI prompts to evaluate candidates for role fit without external machine learning heuristics.
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
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                        }}
                      >
                        🌳 Tree-Based ML Screening
                        <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'rgba(0,0,0,0.2)', padding: '0.15rem 0.4rem', borderRadius: '1rem', marginLeft: '0.25rem' }}>
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
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
                            }}
                          >
                            Uses a fast XGBoost ML model to calculate heuristic probability and risk scoring.
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
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                        }}
                      >
                        🌳+🤖 Tree + AI Hybrid
                        <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'rgba(0,0,0,0.2)', padding: '0.15rem 0.4rem', borderRadius: '1rem', marginLeft: '0.25rem' }}>
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
                              boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
                            }}
                          >
                            Combines Tree-Based ML scoring for fast filtering with AI-based semantic evaluation for high accuracy.
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gap: '1rem' }}>
                {results.length === 0 ? (
                  <div className="glass-panel" style={{ textAlign: 'center', padding: '4rem 2rem', opacity: 0.7 }}>
                    <Search size={48} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
                    <h3>No candidates matched exactly.</h3>
                    <p>Try loosening your constraints or checking your NOT exclusions.</p>
                  </div>
                ) : (
                  results.map((hit, idx) => (
                    <motion.div
                      key={hit.folder_id}
                      className="glass-panel"
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: idx * 0.05 }}
                      style={{ padding: '1.5rem' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                        <div>
                          <h2 style={{ fontSize: '1.4rem', color: '#fff', marginBottom: '0.25rem' }}>{hit.full_name}</h2>
                          {hit.resume_drive_view_url && (
                            <a
                              href={hit.resume_drive_view_url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: '0.85rem', color: '#38bdf8', textDecoration: 'underline', opacity: 0.9 }}
                            >
                              {hit.resume_drive_view_url}
                            </a>
                          )}
                        </div>
                        {hit.resume_drive_view_url && (
                          <a
                            href={hit.resume_drive_view_url}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              background: 'rgba(255,255,255,0.1)', padding: '0.4rem 0.8rem', borderRadius: '0.5rem',
                              fontSize: '0.8rem', color: '#fff', textDecoration: 'none', fontWeight: 500, flexShrink: 0, marginLeft: '1rem'
                            }}
                          >
                            Open Link ↗
                          </a>
                        )}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', gridColumn: '1 / -1' }}>
                          <FileText size={18} style={{ color: '#8b5cf6', marginTop: '0.1rem', flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Summary</div>
                            <ExpandableSummary text={hit.candidate_summary || ''} maxLength={150} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                          <Briefcase size={18} style={{ color: '#3b82f6', marginTop: '0.1rem' }} />
                          <div>
                            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Latest Role</div>
                            <div style={{ fontWeight: 500 }}>{hit.ai_latest_role}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                          <Building2 size={18} style={{ color: '#10b981', marginTop: '0.1rem' }} />
                          <div>
                            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Latest Company</div>
                            <div style={{ fontWeight: 500 }}>{hit.ai_latest_company}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                          <MapPin size={18} style={{ color: '#f59e0b', marginTop: '0.1rem' }} />
                          <div>
                            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Location</div>
                            <div style={{ fontWeight: 500 }}>{hit.ai_latest_location}</div>
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                        <div>
                          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Experience</div>
                          <p style={{ fontSize: '0.9rem', lineHeight: '1.6', color: 'rgba(255,255,255,0.85)', margin: 0, whiteSpace: 'pre-line' }}>
                            {hit.resume_text_excerpt}
                          </p>
                        </div>
                        {hit.education && (
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              <GraduationCap size={14} style={{ color: '#a78bfa' }} />
                              <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Education</div>
                            </div>
                            <p style={{ fontSize: '0.9rem', lineHeight: '1.6', color: 'rgba(255,255,255,0.85)', margin: 0, whiteSpace: 'pre-line' }}>
                              {hit.education}
                            </p>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </div>

        <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
      `}</style>
      </div>

      <AnimatePresence>
        {isOutreachModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed',
              top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0, 0, 0, 0.7)',
              backdropFilter: 'blur(5px)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 1000,
              padding: '1rem'
            }}
          >
            <div
              style={{
                background: '#1e293b',
                width: '100%',
                maxWidth: '600px',
                maxHeight: '90vh',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '1rem',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                overflow: 'hidden'
              }}
            >
              <div style={{ padding: '1.5rem', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#f8fafc' }}>Trigger AI Screening</h2>
                <button onClick={() => setIsOutreachModalOpen(false)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
                  <X size={20} />
                </button>
              </div>

              <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
                <p style={{ color: '#cbd5e1', fontSize: '0.95rem', marginBottom: '1.5rem', marginTop: 0 }}>
                  {screeningEngine === 'llm'
                    ? `Send all ${totalMatches || 'database'} candidates matching the query to the Outreach Agent. The AI will evaluate each profile deeply against your Job Description and email you the results.`
                    : screeningEngine === 'tree_llm'
                    ? `First, the Pure ML Tree will pre-filter the ${totalMatches || 'database'} candidates. The surviving candidates will then be evaluated deeply by the AI against your Job Description and emailed to you.`
                    : `Send all ${totalMatches || 'database'} candidates matching the query to the Outreach Agent. The Tree-Based ML Model will evaluate each profile deeply against your Job Description and email you the results.`
                  }
                </p>

                {(screeningEngine === 'llm' || screeningEngine === 'tree_llm') && (
                  <>
                    <div className="input-group">
                      <label style={{ color: '#f1f5f9' }}>AI Provider <span style={{ color: '#ef4444' }}>*</span></label>
                      <select
                        value={selectedProvider}
                        onChange={e => {
                          const newProv = e.target.value;
                          setSelectedProvider(newProv);
                          if (newProv === 'nvidia') {
                            setSelectedModel('nvidia:meta/llama-3.1-70b-instruct');
                          } else {
                            setSelectedModel('deepseek-ai/DeepSeek-V3.2');
                          }
                        }}
                        style={{
                          background: 'rgba(15, 23, 42, 0.5)',
                          padding: '0.75rem',
                          borderRadius: '0.5rem',
                          border: '1px solid rgba(255,255,255,0.2)',
                          width: '100%',
                          outline: 'none',
                          color: '#fff',
                          cursor: 'pointer',
                          marginBottom: '1rem'
                        }}
                      >
                        <option value="deepinfra" style={{ background: '#1e293b' }}>DeepInfra</option>
                        <option value="nvidia" style={{ background: '#1e293b' }}>NVIDIA NIM</option>
                      </select>
                    </div>

                    <div className="input-group">
                      <label style={{ color: '#f1f5f9' }}>Analytical Model <span style={{ color: '#ef4444' }}>*</span></label>
                      <select
                        value={selectedModel}
                        onChange={e => setSelectedModel(e.target.value)}
                        style={{
                          background: 'rgba(15, 23, 42, 0.5)',
                          padding: '0.75rem',
                          borderRadius: '0.5rem',
                          border: '1px solid rgba(255,255,255,0.2)',
                          width: '100%',
                          outline: 'none',
                          color: '#fff',
                          cursor: 'pointer'
                        }}
                      >
                    {selectedProvider === 'deepinfra' && (
                      <>
                        <option value="deepseek-ai/DeepSeek-V3.2" style={{ background: '#1e293b' }}>DeepSeek V3.2 ($0.26 in / $0.38 out per 1M)</option>
                        <option value="deepseek-ai/DeepSeek-R1" style={{ background: '#1e293b' }}>DeepSeek R1 ($0.50 in / $2.15 out per 1M)</option>
                        <option value="deepseek-ai/DeepSeek-V4-Pro" style={{ background: '#1e293b' }}>DeepSeek V4 Pro ($0.145 cached, $1.74 in, $3.48 out / 1M)</option>
                        <option value="deepseek-ai/DeepSeek-V4-Flash" style={{ background: '#1e293b' }}>DeepSeek V4 Flash ($0.028 cached, $0.14 in, $0.28 out / 1M)</option>
                        <option value="google/gemma-4-31B-it" style={{ background: '#1e293b' }}>Gemma-4-31B-it ($0.13 in, $0.38 out / 1M)</option>
                        <option value="Qwen/Qwen3.6-35B-A3B" style={{ background: '#1e293b' }}>Qwen3.6-35B-A3B ($0.20 in, $1.00 out / 1M)</option>
                        <option value="moonshotai/Kimi-K2.6" style={{ background: '#1e293b' }}>Kimi K2.6 ($0.55 in / $2.50 out per 1M)</option>
                        <option value="zai-org/GLM-5.1" style={{ background: '#1e293b' }}>GLM 5.1 ($1.40 in / $4.40 out per 1M)</option>
                        <option value="stepfun-ai/Step-3.5-Flash" style={{ background: '#1e293b' }}>Step-3.5-Flash ($0.10 in / $0.30 out per 1M)</option>
                        <option value="MiniMaxAI/MiniMax-M2.5" style={{ background: '#1e293b' }}>MiniMax-M2.5 ($0.27 in / $0.95 out per 1M)</option>
                        <option value="openai/gpt-oss-120b" style={{ background: '#1e293b' }}>GPT OSS 120B</option>
                      </>
                    )}
                    {selectedProvider === 'nvidia' && (
                      <>
                        <option value="nvidia:meta/llama-3.1-70b-instruct" style={{ background: '#1e293b' }}>NVIDIA NIM: Llama 3.1 70B</option>
                        <option value="nvidia:meta/llama-3.1-405b-instruct" style={{ background: '#1e293b' }}>NVIDIA NIM: Llama 3.1 405B</option>
                        <option value="nvidia:google/gemma-4-31b-it" style={{ background: '#1e293b' }}>NVIDIA NIM: Gemma 4 31B IT</option>
                        <option value="nvidia:nvidia/llama-3.1-nemotron-70b-instruct" style={{ background: '#1e293b' }}>NVIDIA NIM: Nemotron 70B</option>
                        <option value="nvidia:deepseek-ai/deepseek-v4-pro" style={{ background: '#1e293b' }}>NVIDIA NIM: DeepSeek V4 Pro</option>
                        <option value="nvidia:deepseek-ai/deepseek-v4-flash" style={{ background: '#1e293b' }}>NVIDIA NIM: DeepSeek V4 Flash</option>
                        <option value="nvidia:minimaxai/minimax-m2.7" style={{ background: '#1e293b' }}>NVIDIA NIM: MiniMax M2.7</option>
                        <option value="nvidia:moonshotai/kimi-k2-thinking" style={{ background: '#1e293b' }}>NVIDIA NIM: Kimi K2 Thinking</option>
                        <option value="nvidia:moonshotai/kimi-k2.6" style={{ background: '#1e293b' }}>NVIDIA NIM: Kimi K2.6</option>
                        <option value="nvidia:z-ai/glm-5.1" style={{ background: '#1e293b' }}>NVIDIA NIM: GLM 5.1</option>
                        <option value="nvidia:nvidia/nemotron-3-super-120b-a12b" style={{ background: '#1e293b' }}>NVIDIA NIM: Nemotron 3 Super 120B</option>
                        <option value="nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" style={{ background: '#1e293b' }}>NVIDIA NIM: Nemotron 3 Nano Omni Reasoning</option>
                        <option value="nvidia:nvidia/llama-3.3-nemotron-super-49b-v1.5" style={{ background: '#1e293b' }}>NVIDIA NIM: Llama 3.3 Nemotron Super 49B</option>
                        <option value="nvidia:openai/gpt-oss-120b" style={{ background: '#1e293b' }}>NVIDIA NIM: GPT OSS 120B</option>
                      </>
                    )}
                  </select>
                    </div>
                  </>
                )}

                <div className="input-group">
                  <label style={{ color: '#f1f5f9' }}>Job Name <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    type="text"
                    value={jobName}
                    onChange={e => setJobName(e.target.value)}
                    required
                    placeholder="e.g. Senior Software Engineer"
                    style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.2)', width: '100%', outline: 'none', color: '#fff', boxSizing: 'border-box' }}
                  />
                </div>

                <div className="input-group">
                  <label style={{ color: '#f1f5f9' }}>Company Name <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={e => setCompanyName(e.target.value)}
                    required
                    placeholder="e.g. Metaview"
                    style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.2)', width: '100%', outline: 'none', color: '#fff', boxSizing: 'border-box' }}
                  />
                </div>

                {(screeningEngine === 'llm' || screeningEngine === 'tree_llm') && (
                  <div className="input-group">
                    <label style={{ color: '#f1f5f9' }}>Adjacent Roles (comma separated)</label>
                    <input
                      type="text"
                      value={adjacentRoles}
                      onChange={e => setAdjacentRoles(e.target.value)}
                      placeholder="e.g. AI Researcher, Applied Scientist, ML Engineer"
                      style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.2)', width: '100%', outline: 'none', color: '#fff', boxSizing: 'border-box' }}
                    />
                    <span style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: '0.4rem', display: 'block' }}>Tell the AI to also accept these roles as valid matches for the JD.</span>
                  </div>
                )}

                <div className="input-group">
                  <label style={{ color: '#f1f5f9' }}>Paste Full Job Description <span style={{ color: '#ef4444' }}>*</span></label>
                  <textarea
                    value={outreachJd}
                    onChange={e => setOutreachJd(e.target.value)}
                    rows={6}
                    required
                    placeholder="Enter the Job Description details here. Include strict requirements so the AI knows what to evaluate against."
                    style={{ background: 'rgba(15, 23, 42, 0.5)' }}
                  />
                </div>

                <div className="input-group">
                  <label style={{ color: '#f1f5f9' }}>Result Recipient Email(s) <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    type="text"
                    value={outreachEmail}
                    onChange={e => setOutreachEmail(e.target.value)}
                    required
                    placeholder="e.g. team@company.com, boss@company.com"
                    style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.2)', width: '100%', outline: 'none', color: '#fff', boxSizing: 'border-box' }}
                  />
                </div>


                <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <input
                    type="checkbox"
                    id="bypassDeduplication"
                    checked={bypassDeduplication}
                    onChange={e => setBypassDeduplication(e.target.checked)}
                    style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                  <label htmlFor="bypassDeduplication" style={{ color: '#cbd5e1', cursor: 'pointer', fontSize: '0.9rem' }}>
                    Force Retry: Ignore submission history and screen everyone again.
                  </label>
                </div>

                <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <input
                    type="checkbox"
                    id="useCompanyIntel"
                    checked={useCompanyIntel}
                    onChange={e => setUseCompanyIntel(e.target.checked)}
                    style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                  <label htmlFor="useCompanyIntel" style={{ color: '#cbd5e1', cursor: 'pointer', fontSize: '0.9rem' }}>
                    Use Company Intel: Look up candidate companies in database and attach metadata (size, flight risk, etc) for the LLM.
                  </label>
                </div>

                {/* ── Tree ML Settings ───────────────────────────────── */}
                {(screeningEngine === 'tree' || screeningEngine === 'tree_llm') && (
                  <div className="input-group" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '1.2rem', marginTop: '0.5rem' }}>
                    <label style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <span>🌳</span> ML Tree Settings
                    </label>
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: '1.2rem',
                      background: 'rgba(139, 92, 246, 0.07)',
                      borderRadius: '0.75rem', padding: '1rem 1.2rem',
                      border: '1px solid rgba(139, 92, 246, 0.2)',
                    }}>
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                          <label style={{ color: '#c4b5fd', fontSize: '0.82rem', fontWeight: 500 }}>Select top-K candidates</label>
                          <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.95rem', minWidth: '36px', textAlign: 'right' }}>{treeTopK}</span>
                        </div>
                        <input
                          id="treeTopK-slider"
                          type="range" min={10} max={2000} step={10}
                          value={treeTopK}
                          onChange={e => setTreeTopK(parseInt(e.target.value))}
                          style={{ width: '100%', accentColor: '#8b5cf6', cursor: 'pointer' }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Advanced Pipeline Toggle ─────────────────────────────── */}
                {screeningEngine === 'llm' && (
                  <div className="input-group" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '1.2rem', marginTop: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                      <label style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span>🚀</span> Advanced Pipeline
                      </label>
                      <button
                        id="pipeline-toggle"
                        onClick={() => setUsePipeline(p => !p)}
                        aria-pressed={usePipeline}
                        style={{
                          width: '52px', height: '28px', borderRadius: '14px', border: 'none',
                          background: usePipeline
                            ? 'linear-gradient(135deg, #8b5cf6, #ec4899)'
                            : 'rgba(255,255,255,0.12)',
                          cursor: 'pointer', position: 'relative', transition: 'background 0.25s',
                          flexShrink: 0,
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: '4px',
                          left: usePipeline ? '26px' : '4px',
                          width: '20px', height: '20px', borderRadius: '50%',
                          background: '#fff', transition: 'left 0.25s',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                        }} />
                      </button>
                    </div>
                    <span style={{ color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.5, display: 'block', marginBottom: usePipeline ? '1rem' : 0 }}>
                      Hybrid search + semantic reranking + deterministic LLM audit. Faster &amp; more precise — replaces standard screening when ON.
                    </span>

                    {usePipeline && (
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: '1.2rem',
                        background: 'rgba(139, 92, 246, 0.07)',
                        borderRadius: '0.75rem', padding: '1rem 1.2rem',
                        border: '1px solid rgba(139, 92, 246, 0.2)',
                      }}>

                        {/* top-N slider */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                            <label style={{ color: '#c4b5fd', fontSize: '0.82rem', fontWeight: 500 }}>Retrieve top-N from search</label>
                            <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.95rem', minWidth: '36px', textAlign: 'right' }}>{pipelineTopN}</span>
                          </div>
                          <input
                            id="topN-slider"
                            type="range" min={50} max={1000} step={25}
                            value={pipelineTopN}
                            onChange={e => setPipelineTopN(parseInt(e.target.value))}
                            style={{ width: '100%', accentColor: '#8b5cf6', cursor: 'pointer' }}
                          />
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#475569', fontSize: '0.72rem', marginTop: '2px' }}>
                            <span>50</span>
                            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Stage 2 — hybrid search pool (Meilisearch + pgvector)</span>
                            <span>1000</span>
                          </div>
                        </div>

                        {/* top-K slider */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                            <label style={{ color: '#f9a8d4', fontSize: '0.82rem', fontWeight: 500 }}>Rerank to top-K for LLM audit</label>
                            <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.95rem', minWidth: '36px', textAlign: 'right' }}>{pipelineTopK}</span>
                          </div>
                          <input
                            id="topK-slider"
                            type="range" min={10} max={500} step={10}
                            value={pipelineTopK}
                            onChange={e => setPipelineTopK(parseInt(e.target.value))}
                            style={{ width: '100%', accentColor: '#ec4899', cursor: 'pointer' }}
                          />
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#475569', fontSize: '0.72rem', marginTop: '2px' }}>
                            <span>10</span>
                            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Stage 3 → Stage 4 — reranked shortlist sent to LLM</span>
                            <span>500</span>
                          </div>
                        </div>

                        {/* experience overrides */}
                        <div style={{ display: 'flex', gap: '1rem', borderTop: '1px solid rgba(139,92,246,0.15)', paddingTop: '1rem' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ color: '#c4b5fd', fontSize: '0.82rem', fontWeight: 500, display: 'block', marginBottom: '0.4rem' }}>Min Experience (Years)</label>
                            <input
                              type="number"
                              value={pipelineMinExp}
                              onChange={e => setPipelineMinExp(e.target.value === '' ? '' : parseInt(e.target.value))}
                              min={0} max={50}
                              placeholder="Auto extract"
                              style={{ width: '100%', padding: '0.6rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.4)', border: '1px solid rgba(139,92,246,0.3)', color: '#fff', boxSizing: 'border-box', outline: 'none', fontSize: '0.85rem' }}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ color: '#f9a8d4', fontSize: '0.82rem', fontWeight: 500, display: 'block', marginBottom: '0.4rem' }}>Max Experience (Years)</label>
                            <input
                              type="number"
                              value={pipelineMaxExp}
                              onChange={e => setPipelineMaxExp(e.target.value === '' ? '' : parseInt(e.target.value))}
                              min={0} max={50}
                              placeholder="Auto extract"
                              style={{ width: '100%', padding: '0.6rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.4)', border: '1px solid rgba(139,92,246,0.3)', color: '#fff', boxSizing: 'border-box', outline: 'none', fontSize: '0.85rem' }}
                            />
                          </div>
                        </div>

                        <div style={{ fontSize: '0.75rem', color: '#64748b', borderTop: '1px solid rgba(139,92,246,0.15)', paddingTop: '0.75rem' }}>
                          ⚡ Pipeline: {pipelineTopN} candidates → reranked → {pipelineTopK} → LLM audit → results sorted by attrition hazard
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* ── End Advanced Pipeline ─────────────────────────────────── */}


                {outreachStatus && (
                  <div style={{
                    padding: '1rem',
                    background: (outreachStatus.includes('success') || outreachStatus.includes('Batch Accepted')) ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                    color: (outreachStatus.includes('success') || outreachStatus.includes('Batch Accepted')) ? '#6ee7b7' : '#fca5a5',
                    borderRadius: '0.5rem',
                    marginTop: '1rem',
                    fontSize: '0.9rem'
                  }}>
                    {outreachStatus}
                  </div>
                )}
              </div>

              <div style={{ padding: '1.5rem', background: 'rgba(15, 23, 42, 0.3)', borderTop: '1px solid rgba(255, 255, 255, 0.1)', display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
                <button
                  onClick={() => setIsOutreachModalOpen(false)}
                  style={{ padding: '0.75rem 1.5rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '0.5rem', color: '#f1f5f9', cursor: 'pointer', fontWeight: 500 }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleOutreachSubmit}
                  disabled={isSubmitting || !outreachJd.trim() || !outreachEmail.trim() || !jobName.trim() || !companyName.trim()}
                  style={{
                    background: (isSubmitting || !outreachJd.trim() || !outreachEmail.trim() || !jobName.trim() || !companyName.trim())
                      ? 'rgba(255, 255, 255, 0.1)'
                      : 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '0.5rem',
                    fontWeight: 600,
                    border: 'none',
                    color: (isSubmitting || !outreachJd.trim() || !outreachEmail.trim() || !jobName.trim() || !companyName.trim()) ? '#64748b' : '#fff',
                    cursor: (isSubmitting || !outreachJd.trim() || !outreachEmail.trim() || !jobName.trim() || !companyName.trim()) ? 'not-allowed' : 'pointer',
                    opacity: isSubmitting ? 0.7 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}
                >
                  {isSubmitting ? <Loader2 className="spin" size={16} /> : null}
                  {isSubmitting ? 'Dispatching...' : 'Start AI Screening'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <QueueMonitor status={queueInfo} />
    </>
  );
}

export default App;
