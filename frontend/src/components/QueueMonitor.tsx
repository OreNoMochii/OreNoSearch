
import { motion } from 'framer-motion';
import { Activity, Clock } from 'lucide-react';

export interface QueueStatus {
  activeCount: number;
  maxConcurrent: number;
  pendingCount: number;
  activeBatches: { id: number; size: number; processed: number; owner: string }[];
  queuedBatches: { id: number; size: number; owner: string }[];
}

export function QueueMonitor({ status }: { status: QueueStatus | null }) {
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
