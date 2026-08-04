import { memo } from 'react';
import { motion } from 'framer-motion';
import { FileText, Briefcase, Building2, MapPin, GraduationCap } from 'lucide-react';
import { ExpandableSummary } from './ExpandableSummary';
import type { BooleanHit } from '../searchClient';

interface CandidateCardProps {
  hit: BooleanHit;
  idx: number;
}

export const CandidateCard = memo(({ hit, idx }: CandidateCardProps) => {
  return (
    <motion.div
      className="glass-panel"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: idx * 0.05 }}
      style={{ padding: '1.5rem' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '1rem',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.25rem', color: '#f8fafc' }}>{hit.full_name}</h3>
            {hit.tree_score !== undefined && (
              <span
                style={{
                  background: 'rgba(16, 185, 129, 0.1)',
                  color: '#10b981',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '1rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                }}
              >
                ML Score: {(hit.tree_score * 100).toFixed(1)}%
              </span>
            )}
            {hit.pipeline_score !== undefined && (
              <span
                style={{
                  background: 'rgba(59, 130, 246, 0.1)',
                  color: '#60a5fa',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '1rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                }}
              >
                Rerank Score: {(hit.pipeline_score * 100).toFixed(1)}%
              </span>
            )}
          </div>
          <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            {hit.candidate_email} • {hit.candidate_phone}
          </div>
          {hit.resume_drive_view_url && (
            <a
              href={hit.resume_drive_view_url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-block',
                marginTop: '0.5rem',
                color: '#60a5fa',
                textDecoration: 'none',
                fontSize: '0.85rem',
                opacity: 0.9,
              }}
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
              background: 'rgba(255,255,255,0.1)',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.5rem',
              fontSize: '0.8rem',
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 500,
              flexShrink: 0,
              marginLeft: '1rem',
            }}
          >
            Open Link ↗
          </a>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
          paddingBottom: '1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            gridColumn: '1 / -1',
          }}
        >
          <FileText size={18} style={{ color: '#8b5cf6', marginTop: '0.1rem', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
                marginBottom: '0.25rem',
              }}
            >
              Summary
            </div>
            <ExpandableSummary text={hit.candidate_summary || ''} maxLength={150} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <Briefcase size={18} style={{ color: '#3b82f6', marginTop: '0.1rem' }} />
          <div>
            <div
              style={{
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
              }}
            >
              Latest Role
            </div>
            <div style={{ fontWeight: 500 }}>{hit.ai_latest_role}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <Building2 size={18} style={{ color: '#10b981', marginTop: '0.1rem' }} />
          <div>
            <div
              style={{
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
              }}
            >
              Latest Company
            </div>
            <div style={{ fontWeight: 500 }}>{hit.ai_latest_company}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <MapPin size={18} style={{ color: '#f59e0b', marginTop: '0.1rem' }} />
          <div>
            <div
              style={{
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
              }}
            >
              Location
            </div>
            <div style={{ fontWeight: 500 }}>{hit.ai_latest_location}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        <div>
          <div
            style={{
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: '0.5rem',
            }}
          >
            Experience
          </div>
          <p
            style={{
              fontSize: '0.9rem',
              lineHeight: '1.6',
              color: 'rgba(255,255,255,0.85)',
              margin: 0,
              whiteSpace: 'pre-line',
            }}
          >
            {hit.resume_text_excerpt}
          </p>
        </div>
        {hit.education && (
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '0.5rem',
              }}
            >
              <GraduationCap size={14} style={{ color: '#a78bfa' }} />
              <div
                style={{
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--text-muted)',
                }}
              >
                Education
              </div>
            </div>
            <p
              style={{
                fontSize: '0.9rem',
                lineHeight: '1.6',
                color: 'rgba(255,255,255,0.85)',
                margin: 0,
                whiteSpace: 'pre-line',
              }}
            >
              {hit.education}
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
});
