/**
 * schemas.ts — the contracts between agentic screening stages.
 *
 * Every stage boundary is validated. The previous agent parsed one large JSON
 * blob and read fields off it directly, so a partial response surfaced as a
 * TypeError deep inside the retry loop. Here each stage has a narrow shape and
 * a parse that either succeeds or fails loudly at the boundary.
 */
import { z } from 'zod';

// ── Stage 0: the compiled rubric ────────────────────────────────────────────

/**
 * A binary, disqualifying requirement.
 *
 * Knockouts are separated from scored competencies because they behave
 * differently: no amount of strength elsewhere compensates for failing one.
 * The old rubric collapsed both into a 1-5 score, so a candidate could fail a
 * genuine must-have and still average out to a RETAIN.
 */
export const Knockout = z.object({
  id: z.string().min(1),
  /** Human-readable statement of the requirement. */
  requirement: z.string().min(1),
  /**
   * How to check it. `structured` knockouts are evaluated in code against
   * database fields and never reach a model; `evidence` knockouts need the
   * resume text read.
   */
  kind: z.enum(['structured', 'evidence']),
  /** For structured knockouts: which field and what bound. */
  field: z
    .enum(['total_experience_months', 'location', 'current_company', 'latest_role'])
    .optional(),
  operator: z.enum(['gte', 'lte', 'includes_any', 'excludes_all']).optional(),
  value: z.union([z.number(), z.array(z.string())]).optional(),
});
export type Knockout = z.infer<typeof Knockout>;

/** A scored, weighted requirement. */
export const Competency = z.object({
  id: z.string().min(1),
  requirement: z.string().min(1),
  /** Relative importance. Normalised across the rubric before scoring. */
  weight: z.number().min(0).max(10).default(1),
  /** What strong evidence for this looks like — steers extraction. */
  evidence_hint: z.string().default(''),
});
export type Competency = z.infer<typeof Competency>;

export const JdRubric = z.object({
  role_title: z.string().default(''),
  /** Compact restatement of the role, used in downstream prompts instead of
   *  re-sending the entire JD to every stage. */
  role_summary: z.string().default(''),
  seniority_band: z.enum(['junior', 'mid', 'senior', 'lead', 'executive', 'unspecified']),
  min_years_experience: z.number().min(0).max(60).nullable().default(null),
  max_years_experience: z.number().min(0).max(60).nullable().default(null),
  knockouts: z.array(Knockout).max(20).default([]),
  competencies: z.array(Competency).min(1).max(20),
  /** Titles or backgrounds that count as equivalent. */
  adjacent_roles: z.array(z.string()).max(30).default([]),
  /** Signals that argue against a fit — the challenger looks for these. */
  anti_signals: z.array(z.string()).max(20).default([]),
  /** Anything the JD leaves genuinely ambiguous. Surfaced for human review
   *  rather than silently resolved by the model. */
  open_questions: z.array(z.string()).max(20).default([]),
});
export type JdRubric = z.infer<typeof JdRubric>;

// ── Stage 3: evidence extraction ────────────────────────────────────────────

export const ExtractedEvidence = z.object({
  /** Must correspond to a Knockout.id or Competency.id from the rubric. */
  requirement_id: z.string(),
  /** Verbatim spans from the profile. Verified in code before use. */
  quotes: z.array(z.string()).max(6).default([]),
  /** The model's read of whether the profile addresses this at all. */
  addressed: z.boolean().default(false),
});
export type ExtractedEvidence = z.infer<typeof ExtractedEvidence>;

export const EvidenceBundle = z.object({
  findings: z.array(ExtractedEvidence).max(40).default([]),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;

// ── Stage 4: adjudication ───────────────────────────────────────────────────

export const CompetencyScore = z.object({
  requirement_id: z.string(),
  /**
   * 0 = no evidence, 1 = weak/tangential, 2 = partial, 3 = solid, 4 = strong.
   *
   * Deliberately anchored at 0 rather than 1: "no evidence" and "weak
   * evidence" are different states and the old 1-5 scale could not express
   * the difference, which pushed unevidenced requirements into the same bucket
   * as poorly-evidenced ones.
   */
  score: z.number().min(0).max(4),
  rationale: z.string().default(''),
});
export type CompetencyScore = z.infer<typeof CompetencyScore>;

export const KnockoutVerdict = z.object({
  knockout_id: z.string(),
  /** true = satisfied, false = violated, null = cannot tell from the profile. */
  satisfied: z.boolean().nullable(),
  rationale: z.string().default(''),
});
export type KnockoutVerdict = z.infer<typeof KnockoutVerdict>;

export const Adjudication = z.object({
  knockouts: z.array(KnockoutVerdict).default([]),
  competencies: z.array(CompetencyScore).default([]),
  seniority_assessment: z.string().default(''),
  estimated_years: z.number().min(0).max(70).nullable().default(null),
});
export type Adjudication = z.infer<typeof Adjudication>;

// ── Stage 5: the challenger ─────────────────────────────────────────────────

export const ChallengeFinding = z.object({
  /** What disqualifies them. */
  objection: z.string().min(1),
  /** Verbatim support. Verified in code — an unverifiable objection is
   *  discarded exactly like unverifiable praise. */
  quote: z.string().default(''),
  severity: z.enum(['fatal', 'serious', 'minor']),
});
export type ChallengeFinding = z.infer<typeof ChallengeFinding>;

export const Challenge = z.object({
  findings: z.array(ChallengeFinding).max(10).default([]),
  /** The challenger's own bottom line, used only as a tiebreak signal. */
  would_reject: z.boolean().default(false),
});
export type Challenge = z.infer<typeof Challenge>;

// ── Stage 6: the decision ───────────────────────────────────────────────────

export type Decision = 'PASS' | 'REJECT' | 'UNCERTAIN';

export const DECISION_STAGES = [
  'gates',
  'prefilter',
  'evidence',
  'adjudicator',
  'challenger',
  'decision',
] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];
