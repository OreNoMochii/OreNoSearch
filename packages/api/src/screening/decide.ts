/**
 * decide.ts — Stage 6: combine the stages into one of three outcomes.
 *
 * The third outcome is the important one.
 *
 * A binary screener must commit on every candidate, including the ones where
 * the profile is thin, the evidence is ambiguous, or two stages disagree.
 * Those are precisely the cases it gets wrong, and because it had to answer,
 * the wrong answer arrives with the same confidence as a right one. Forcing a
 * decision under uncertainty is the main manufacturing process for false
 * positives.
 *
 * UNCERTAIN routes those candidates to a human (or a larger model) instead.
 * That is what buys high precision on PASS: the system is allowed to say "I
 * don't know", so the things it does say PASS to are the ones it is actually
 * confident about.
 *
 * Ordering matters. Knockouts are absolute and evaluated first — no weighted
 * score can rescue a candidate who fails a stated must-have, which was a real
 * failure mode of the old 1-5 average.
 */
import type { Adjudication, Decision, DecisionStage, JdRubric } from './schemas';
import type { ChallengeResult } from './challenger';
import type { GateResult } from './gates';
import { config } from '../config';

export interface DecisionInput {
  rubric: JdRubric;
  gates: GateResult;
  adjudication?: Adjudication;
  weightedScore: number;
  challenge?: ChallengeResult;
  /** Verified quotes across all requirements. Zero means nothing was proven. */
  verifiedQuotes: number;
  /** Set when a stage failed outright rather than returning a low score. */
  stageFailure?: string;
}

export interface DecisionOutcome {
  decision: Decision;
  stage: DecisionStage;
  /** 0-1. For PASS this is the weighted score; for a knockout rejection it is
   *  1 (we are certain they failed), not 0. */
  confidence: number;
  reason: string;
}

export function decide(input: DecisionInput): DecisionOutcome {
  const { rubric, gates, adjudication, weightedScore, challenge } = input;
  const passThreshold = config.SCREENING_PASS_THRESHOLD;
  const band = config.SCREENING_UNCERTAIN_BAND;

  // ── 1. Deterministic gates are absolute ───────────────────────────────────
  if (!gates.passed) {
    const first = gates.failures[0];
    return {
      decision: 'REJECT',
      stage: 'gates',
      confidence: 1,
      reason: `Failed must-have: ${first.requirement} (${first.detail})`,
    };
  }

  // ── 2. A stage that failed is not a rejection ─────────────────────────────
  // An API error or an unparseable response says nothing about the candidate.
  // Treating it as a REJECT would silently drop qualified people whenever the
  // provider had a bad minute.
  if (input.stageFailure) {
    return {
      decision: 'UNCERTAIN',
      stage: 'decision',
      confidence: 0,
      reason: `Could not complete screening: ${input.stageFailure}`,
    };
  }

  if (!adjudication) {
    return {
      decision: 'UNCERTAIN',
      stage: 'adjudicator',
      confidence: 0,
      reason: 'No adjudication was produced.',
    };
  }

  // ── 3. Evidence-based knockouts ───────────────────────────────────────────
  const violated = adjudication.knockouts.filter((k) => k.satisfied === false);
  if (violated.length > 0) {
    const names = new Map(rubric.knockouts.map((k) => [k.id, k.requirement]));
    return {
      decision: 'REJECT',
      stage: 'adjudicator',
      confidence: 1,
      reason: `Must-have not met: ${names.get(violated[0].knockout_id) ?? violated[0].knockout_id}. ${violated[0].rationale}`,
    };
  }

  // An unresolved must-have is exactly the case a human should see. It is not
  // a rejection — the evidence simply did not say — and it must not be a pass.
  const unresolved = adjudication.knockouts.filter((k) => k.satisfied === null);
  if (unresolved.length > 0) {
    const names = new Map(rubric.knockouts.map((k) => [k.id, k.requirement]));
    return {
      decision: 'UNCERTAIN',
      stage: 'adjudicator',
      confidence: weightedScore,
      reason: `Cannot confirm must-have from the profile: ${names.get(unresolved[0].knockout_id) ?? unresolved[0].knockout_id}`,
    };
  }

  // ── 4. The challenger can reject, but never promote ───────────────────────
  if (challenge?.ok && challenge.verifiedFatal > 0) {
    const fatal = challenge.challenge?.findings.find((f) => f.severity === 'fatal');
    return {
      decision: 'REJECT',
      stage: 'challenger',
      confidence: 1,
      reason: `Disqualifying objection: ${fatal?.objection ?? 'a must-have failure was found on review'}`,
    };
  }

  // Several serious-but-not-fatal objections are not individually
  // disqualifying, yet collectively they are a reason to look rather than to
  // send. Escalate instead of guessing.
  if (challenge?.ok && challenge.verifiedSerious >= 2 && weightedScore < passThreshold + band) {
    return {
      decision: 'UNCERTAIN',
      stage: 'challenger',
      confidence: weightedScore,
      reason: `${challenge.verifiedSerious} serious objections raised on review.`,
    };
  }

  // ── 5. Nothing was actually proven ────────────────────────────────────────
  // A candidate can reach here with a respectable score built entirely on the
  // adjudicator's generosity toward empty evidence. Without a single verified
  // quote there is no basis for a positive claim about them.
  if (input.verifiedQuotes === 0) {
    return {
      decision: 'UNCERTAIN',
      stage: 'evidence',
      confidence: 0,
      reason: 'No verifiable evidence was found in the profile for any requirement.',
    };
  }

  // ── 6. The weighted score ─────────────────────────────────────────────────
  if (weightedScore >= passThreshold) {
    return {
      decision: 'PASS',
      stage: 'decision',
      confidence: weightedScore,
      reason: `Meets the rubric (weighted score ${(weightedScore * 100).toFixed(0)}%).`,
    };
  }

  if (weightedScore >= passThreshold - band) {
    return {
      decision: 'UNCERTAIN',
      stage: 'decision',
      confidence: weightedScore,
      reason: `Borderline (weighted score ${(weightedScore * 100).toFixed(0)}%, threshold ${(passThreshold * 100).toFixed(0)}%).`,
    };
  }

  return {
    decision: 'REJECT',
    stage: 'decision',
    confidence: weightedScore,
    reason: `Below the bar (weighted score ${(weightedScore * 100).toFixed(0)}%, threshold ${(passThreshold * 100).toFixed(0)}%).`,
  };
}
