import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { MapPin, Clock } from 'lucide-react';
import type { BooleanHit } from '../searchClient';
import { parseExperienceYears } from '../searchClient';

interface CandidateCardProps {
  hit: BooleanHit;
  idx: number;
  onOpenProfile: (hit: BooleanHit) => void;
  onExclude?: (hit: BooleanHit) => void;
  onSelect?: (hit: BooleanHit) => void;
  isSelected?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

/** First meaningful line of the experience blob — the "most recent" role. */
function mostRecentRole(raw?: string): string | null {
  if (!raw?.trim()) return null;
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 2);
  if (!line) return null;
  return line.length > 96 ? `${line.slice(0, 96)}…` : line;
}

function topSkills(raw?: string, max = 5): string[] {
  if (!raw?.trim()) return [];
  return Array.from(
    new Set(
      raw
        .split(/[,\n;·|]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 28),
    ),
  ).slice(0, max);
}

export const CandidateCard = memo(
  ({ hit, idx, onOpenProfile, onExclude, onSelect, isSelected }: CandidateCardProps) => {
    const years = useMemo(
      () => parseExperienceYears(hit.resume_text_excerpt),
      [hit.resume_text_excerpt],
    );
    const skills = useMemo(() => topSkills(hit.skills), [hit.skills]);
    const recent = useMemo(
      () => mostRecentRole(hit.resume_text_excerpt),
      [hit.resume_text_excerpt],
    );

    // Only shown when an engine genuinely produced a score. The SQL boolean
    // search has no notion of relevance, so a percentage there would be a
    // confident number with nothing behind it.
    const score = hit.pipeline_score ?? hit.tree_score;

    return (
      <motion.article
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay: Math.min(idx, 8) * 0.025 }}
        className={`flex w-full gap-4 rounded-[8px] border bg-raised p-5 transition-colors ${
          isSelected ? 'border-accent-line' : 'border-transparent hover:border-line'
        }`}
      >
        {/* ── Info ─────────────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {hit.ai_latest_company && (
              <span className="max-w-full truncate text-[15px] font-bold text-accent">
                {hit.ai_latest_company}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
              {hit.ai_latest_role || 'Role not stated'}
            </span>
          </div>

          {hit.candidate_summary && (
            <p className="line-clamp-2 text-[12px] leading-[18px] text-ink-2">
              {hit.candidate_summary}
            </p>
          )}

          <span className="text-[11px] text-ink-3">{hit.full_name || 'Unknown candidate'}</span>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
            {hit.ai_latest_location && (
              <span className="flex items-center gap-1">
                <MapPin size={11} aria-hidden="true" />
                {hit.ai_latest_location}
              </span>
            )}
            {years > 0 && (
              <span className="flex items-center gap-1">
                <Clock size={11} aria-hidden="true" />
                {years.toFixed(years % 1 === 0 ? 0 : 1)} years
              </span>
            )}
          </div>

          {recent && (
            <div className="mt-1.5 flex w-full flex-col gap-0.5 rounded-[4px] bg-input px-3 py-2">
              <span className="text-[9px] font-semibold uppercase tracking-[1px] text-ink-3">
                Most recent
              </span>
              <span className="truncate text-[12px] font-medium text-ink">{recent}</span>
            </div>
          )}

          {skills.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {skills.map((s) => (
                <span
                  key={s}
                  className="rounded-[4px] bg-input px-2.5 py-1 text-[11px] font-medium text-ink-2"
                >
                  {s}
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-3">
            {onSelect && (
              <button
                type="button"
                onClick={() => onSelect(hit)}
                aria-pressed={isSelected}
                className={`cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-medium transition-colors ${
                  isSelected ? 'text-accent' : 'text-ink-3 hover:text-accent'
                }`}
              >
                {isSelected ? '✓ Selected for outreach' : 'Select for outreach'}
              </button>
            )}
            {onExclude && (
              <button
                type="button"
                onClick={() => onExclude(hit)}
                className="cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-medium text-ink-3 transition-colors hover:text-danger"
              >
                Exclude
              </button>
            )}
          </div>
        </div>

        {/* ── Match ────────────────────────────────────────────────────── */}
        <div className="flex w-[72px] shrink-0 flex-col items-center gap-0.5">
          {score !== undefined && (
            <>
              <span className="text-[18px] font-semibold tabular-nums text-accent">
                {(score * 100).toFixed(0)}%
              </span>
              <span className="text-[9px] tracking-[0.8px] text-ink-3">match</span>
            </>
          )}
          <button
            type="button"
            onClick={() => onOpenProfile(hit)}
            className="mt-1 cursor-pointer border-none bg-transparent px-0 py-1 text-[12px] font-medium text-ink-3 transition-colors hover:text-accent"
          >
            View →
          </button>
        </div>

        {/* ── Avatar ───────────────────────────────────────────────────── */}
        <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[6px] bg-accent-soft">
          <span className="text-[14px] font-semibold text-accent">
            {initials(hit.full_name ?? '')}
          </span>
        </div>
      </motion.article>
    );
  },
);

CandidateCard.displayName = 'CandidateCard';
