import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MapPin, Clock, GraduationCap, Mail, ExternalLink } from 'lucide-react';
import type { BooleanHit } from '../searchClient';
import { parseExperienceYears } from '../searchClient';
import { SectionLabel, Button } from './ui';

interface CandidateProfileModalProps {
  hit: BooleanHit | null;
  onClose: () => void;
  onShortlist?: (hit: BooleanHit) => void;
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

interface ExperienceBlock {
  heading: string;
  detail: string;
}

function parseExperience(raw?: string): ExperienceBlock[] {
  if (!raw?.trim()) return [];
  const blocks = raw
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const source = blocks.length > 1 ? blocks : [raw.trim()];
  return source.slice(0, 12).map((block) => {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      heading: lines[0] ?? '',
      detail: lines.slice(1).join('\n'),
    };
  });
}

function parseSkills(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return Array.from(
    new Set(
      raw
        .split(/[,\n;·|]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 40),
    ),
  ).slice(0, 24);
}

/** Metadata pill — location, tenure. Same skin as the rest of the app's wells. */
function MetaPill({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[6px] bg-input px-3 py-2 text-[12.5px] text-ink-2">
      {icon}
      {children}
    </span>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function CandidateProfileModal({ hit, onClose, onShortlist }: CandidateProfileModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hit) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Keep Tab inside the dialog. Without this, focus walks out into the
      // page behind the overlay, which is still there but not operable.
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [hit, onClose]);

  const experience = parseExperience(hit?.resume_text_excerpt);
  const skills = parseSkills(hit?.skills);
  const years = hit ? parseExperienceYears(hit.resume_text_excerpt) : 0;

  return createPortal(
    <AnimatePresence>
      {hit && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="candidate-profile-name"
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.18 }}
            className="relative flex max-h-[92vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-2xl"
          >
            {/* ── Header ──────────────────────────────────────────────── */}
            <div className="flex shrink-0 items-center justify-between border-b border-line px-8 py-5">
              <SectionLabel>Candidate profile</SectionLabel>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close profile"
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[6px] border-none bg-input text-ink-2 transition-colors hover:bg-input-hover hover:text-ink"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {/* ── Body ────────────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px]">
                {/* ── Left column ───────────────────────────────────── */}
                <div className="flex min-w-0 flex-col gap-8 px-8 py-8">
                  <div className="flex items-center gap-5">
                    <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[8px] bg-accent-soft">
                      <span className="text-[24px] font-semibold text-accent">
                        {initials(hit.full_name ?? '')}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      {hit.ai_latest_company && (
                        <span className="truncate text-[13px] font-semibold text-accent">
                          {hit.ai_latest_company}
                        </span>
                      )}
                      <h1
                        id="candidate-profile-name"
                        className="text-balance text-[24px] font-bold leading-tight text-ink"
                      >
                        {hit.ai_latest_role || 'Role not stated'}
                      </h1>
                      <span className="text-[13px] text-ink-2">{hit.full_name || 'Unknown'}</span>
                    </div>
                  </div>

                  {(hit.ai_latest_location || years > 0) && (
                    <div className="flex flex-wrap gap-2">
                      {hit.ai_latest_location && (
                        <MetaPill icon={<MapPin size={12} aria-hidden="true" />}>
                          {hit.ai_latest_location}
                        </MetaPill>
                      )}
                      {years > 0 && (
                        <MetaPill icon={<Clock size={12} aria-hidden="true" />}>
                          {years.toFixed(years % 1 === 0 ? 0 : 1)} years experience
                        </MetaPill>
                      )}
                    </div>
                  )}

                  {hit.candidate_summary && (
                    <section className="flex flex-col gap-3">
                      <SectionLabel>About</SectionLabel>
                      <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-ink-2">
                        {hit.candidate_summary}
                      </p>
                    </section>
                  )}

                  {experience.length > 0 && (
                    <section className="flex flex-col gap-4">
                      <SectionLabel>Experience</SectionLabel>
                      <div className="flex flex-col gap-6">
                        {experience.map((block, i) => {
                          let role = block.heading;
                          let company = '';
                          if (block.heading.includes(' at ')) {
                            const parts = block.heading.split(' at ');
                            role = parts[0];
                            company = parts.slice(1).join(' at ');
                          }

                          return (
                            <div key={i} className="flex flex-col gap-1">
                              <div className="text-[14px] font-semibold text-ink">{role}</div>
                              {company && (
                                <div className="text-[13px] font-medium text-accent">{company}</div>
                              )}
                              {block.detail && (
                                <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-2">
                                  {block.detail}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </div>

                {/* ── Right rail ────────────────────────────────────── */}
                <aside className="flex min-w-0 flex-col gap-8 border-line bg-base px-8 py-8 lg:border-l">
                  {skills.length > 0 && (
                    <section className="flex flex-col gap-3">
                      <SectionLabel>Skills &amp; tools</SectionLabel>
                      {/* Rendered as flat tags, not proficiency bars.
                          The bars here were computed from `skill.length % 3`
                          and labelled "Expert" / "Advanced" — a fabricated
                          assessment of a real person, shown to a recruiter
                          deciding whether to contact them. The corpus carries
                          no proficiency signal, so none is claimed. */}
                      <div className="flex flex-wrap gap-1.5">
                        {skills.map((s) => (
                          <span
                            key={s}
                            className="rounded-[4px] bg-input px-2.5 py-1.5 text-[11.5px] font-medium text-ink-2"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}

                  {hit.education && (
                    <section className="flex flex-col gap-3">
                      <SectionLabel>Education</SectionLabel>
                      <p className="flex gap-2 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-2">
                        <GraduationCap
                          size={13}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-ink-3"
                        />
                        {hit.education}
                      </p>
                    </section>
                  )}

                  {hit.candidate_email && (
                    <section className="flex flex-col gap-3">
                      <SectionLabel>Contact</SectionLabel>
                      <a
                        href={`mailto:${hit.candidate_email}`}
                        className="flex items-center gap-2 break-all text-[12.5px] text-accent no-underline hover:underline"
                      >
                        <Mail size={13} aria-hidden="true" className="shrink-0" />
                        {hit.candidate_email}
                      </a>
                    </section>
                  )}
                </aside>
              </div>
            </div>

            {/* ── Footer ──────────────────────────────────────────────── */}
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-8 py-4">
              {hit.resume_drive_view_url && (
                <a
                  href={hit.resume_drive_view_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[6px] bg-transparent px-4 py-2.5 text-[12px] font-medium text-ink-2 no-underline transition-colors hover:bg-input hover:text-ink"
                >
                  <ExternalLink size={13} aria-hidden="true" /> Source profile
                </a>
              )}
              <Button tone="secondary" onClick={onClose}>
                Close
              </Button>
              {onShortlist && (
                <Button tone="primary" onClick={() => onShortlist(hit)}>
                  Shortlist
                </Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
