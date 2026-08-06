/**
 * gates.ts — Stage 1: deterministic knockouts. No model, no variance, no cost.
 *
 * Anything checkable against a structured field belongs here rather than in a
 * prompt. Three reasons, in order of importance:
 *
 *   1. It is always right. "Does this person have 5 years of experience?" is
 *      arithmetic, and asking a language model to do arithmetic on a resume is
 *      strictly worse than doing the arithmetic.
 *   2. It is free, and it removes the majority of candidates before any token
 *      is spent — which is what makes the expensive stages affordable.
 *   3. It is explainable. A rejection here cites a number, not a paragraph.
 *
 * The bar for putting a check here is that it must never produce a false
 * rejection. Where the data is missing or ambiguous, the gate PASSES the
 * candidate through to the model rather than guessing — a gate that rejects on
 * absent data would silently delete qualified people.
 */
import type { ScreenedCandidate } from '../domain/ports';
import type { JdRubric, Knockout } from './schemas';
import { parseTotalExperienceMonths } from './experience';

export interface GateFailure {
  knockoutId: string;
  requirement: string;
  detail: string;
}

export interface GateResult {
  passed: boolean;
  failures: GateFailure[];
  /** Checks that could not be evaluated because the data was absent. Passed
   *  through to the model stages rather than assumed either way. */
  indeterminate: string[];
}

/** Extra constraints the campaign imposes on top of the rubric. */
export interface CampaignConstraints {
  excludeCompanies?: readonly string[];
  requiredLocations?: readonly string[];
  minExpYears?: number;
  maxExpYears?: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

function checkStructuredKnockout(
  knockout: Knockout,
  candidate: ScreenedCandidate,
  months: number | null,
): 'pass' | 'fail' | 'indeterminate' {
  const { field, operator, value } = knockout;
  if (!field || !operator || value === undefined) return 'indeterminate';

  switch (field) {
    case 'total_experience_months': {
      if (months === null) return 'indeterminate';
      if (typeof value !== 'number') return 'indeterminate';
      if (operator === 'gte') return months >= value ? 'pass' : 'fail';
      if (operator === 'lte') return months <= value ? 'pass' : 'fail';
      return 'indeterminate';
    }

    case 'location':
    case 'current_company':
    case 'latest_role': {
      const haystack = norm(
        field === 'location'
          ? (candidate.location ?? '')
          : field === 'current_company'
            ? (candidate.currentCompany ?? '')
            : (candidate.headline ?? ''),
      );
      if (!haystack || haystack === 'n/a') return 'indeterminate';
      if (!Array.isArray(value)) return 'indeterminate';

      const needles = value.map(norm).filter(Boolean);
      if (needles.length === 0) return 'indeterminate';

      const hit = needles.some((n) => haystack.includes(n));
      if (operator === 'includes_any') return hit ? 'pass' : 'fail';
      if (operator === 'excludes_all') return hit ? 'fail' : 'pass';
      return 'indeterminate';
    }

    default:
      return 'indeterminate';
  }
}

/**
 * Applies every structured knockout plus the campaign's own constraints.
 *
 * Evidence-kind knockouts are deliberately not evaluated here — they need the
 * resume read, and that is the adjudicator's job.
 */
export function applyGates(
  candidate: ScreenedCandidate,
  rubric: JdRubric,
  constraints: CampaignConstraints = {},
): GateResult {
  const failures: GateFailure[] = [];
  const indeterminate: string[] = [];

  const months = parseTotalExperienceMonths(candidate.experience);

  for (const knockout of rubric.knockouts) {
    if (knockout.kind !== 'structured') continue;

    const outcome = checkStructuredKnockout(knockout, candidate, months);
    if (outcome === 'fail') {
      failures.push({
        knockoutId: knockout.id,
        requirement: knockout.requirement,
        detail: describeFailure(knockout, candidate, months),
      });
    } else if (outcome === 'indeterminate') {
      indeterminate.push(knockout.id);
    }
  }

  // ── Campaign-level constraints ────────────────────────────────────────────
  // These come from the search form rather than the JD, so they are applied
  // even when the rubric does not mention them.
  if (constraints.minExpYears !== undefined && months !== null) {
    const required = constraints.minExpYears * 12;
    if (months < required) {
      failures.push({
        knockoutId: 'campaign_min_exp',
        requirement: `At least ${constraints.minExpYears} years of experience`,
        detail: `${(months / 12).toFixed(1)} years found`,
      });
    }
  }

  if (constraints.maxExpYears !== undefined && months !== null) {
    const ceiling = constraints.maxExpYears * 12;
    if (months > ceiling) {
      failures.push({
        knockoutId: 'campaign_max_exp',
        requirement: `At most ${constraints.maxExpYears} years of experience`,
        detail: `${(months / 12).toFixed(1)} years found`,
      });
    }
  }

  if (constraints.excludeCompanies?.length) {
    const current = norm(candidate.currentCompany ?? '');
    if (current && current !== 'n/a') {
      const hit = constraints.excludeCompanies
        .map(norm)
        .filter(Boolean)
        .find((c) => current.startsWith(c) || current.includes(c));
      if (hit) {
        failures.push({
          knockoutId: 'campaign_excluded_company',
          requirement: 'Not currently at an excluded company',
          detail: `Currently at "${candidate.currentCompany}"`,
        });
      }
    }
  }

  if (constraints.requiredLocations?.length) {
    const loc = norm(candidate.location ?? '');
    if (!loc || loc === 'n/a') {
      indeterminate.push('campaign_location');
    } else {
      const hit = constraints.requiredLocations.map(norm).some((l) => l && loc.includes(l));
      if (!hit) {
        failures.push({
          knockoutId: 'campaign_location',
          requirement: `Located in one of: ${constraints.requiredLocations.join(', ')}`,
          detail: `Located in "${candidate.location}"`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures, indeterminate };
}

function describeFailure(
  knockout: Knockout,
  candidate: ScreenedCandidate,
  months: number | null,
): string {
  switch (knockout.field) {
    case 'total_experience_months':
      return months === null
        ? 'experience could not be parsed'
        : `${(months / 12).toFixed(1)} years found, required ${String(knockout.value)} months`;
    case 'location':
      return `location is "${candidate.location ?? 'unknown'}"`;
    case 'current_company':
      return `current company is "${candidate.currentCompany ?? 'unknown'}"`;
    case 'latest_role':
      return `current role is "${candidate.headline ?? 'unknown'}"`;
    default:
      return 'structured check failed';
  }
}
