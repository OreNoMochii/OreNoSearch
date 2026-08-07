/**
 * pipeline.ts — runs one candidate through stages 1-6.
 *
 * Stage 0 (rubric compilation) happens once per campaign and is passed in.
 *
 * The shape here is a funnel, and the ordering is the optimisation: each stage
 * is more expensive than the one before it and only sees what the previous one
 * could not settle. The deterministic gates are free and reject the majority,
 * which is what makes it affordable to spend three model calls on the ones that
 * survive. Screening every candidate with the expensive path would cost more
 * and decide worse.
 */
import type { ScreenedCandidate } from '../domain/ports';
import type { JdRubric, Decision, DecisionStage } from './schemas';
import { applyGates, type CampaignConstraints, type GateResult } from './gates';
import { extractEvidence, type VerifiedFinding } from './evidence';
import { adjudicate } from './adjudicator';
import { challenge, type ChallengeResult } from './challenger';
import { decide } from './decide';
import { emptyUsage, addUsage, type TokenUsage } from './llm';
import { logInfo, logWarn } from '../utils/logger';
import type { Adjudication } from './schemas';

export interface CandidateOutcome {
  profileUrl: string;
  decision: Decision;
  stage: DecisionStage;
  confidence: number;
  reason: string;

  gates: GateResult;
  findings: VerifiedFinding[];
  adjudication?: Adjudication;
  weightedScore: number;
  challengeResult?: ChallengeResult;

  verifiedQuotes: number;
  fabricatedQuotes: number;
  usage: TokenUsage;
  durationMs: number;
}

export async function screenCandidate(
  candidate: ScreenedCandidate,
  rubric: JdRubric,
  constraints: CampaignConstraints = {},
): Promise<CandidateOutcome> {
  const started = Date.now();
  const usage = emptyUsage();

  // `name` is rendered by pino-pretty in the "(name/pid)" prefix, so putting
  // the candidate there makes a wave of interleaved concurrent logs readable
  // without repeating the field in every payload.
  const name = candidate.name ?? 'Unknown';

  // Which stages actually executed, in order. A single candidate's journey is
  // otherwise only inferrable by correlating five separate log lines, and the
  // funnel shape is the main thing worth knowing about this pipeline.
  const path: string[] = [];
  let mark = Date.now();
  const lap = (): number => {
    const ms = Date.now() - mark;
    mark = Date.now();
    return ms;
  };

  const base = {
    profileUrl: candidate.profileUrl,
    findings: [] as VerifiedFinding[],
    weightedScore: 0,
    verifiedQuotes: 0,
    fabricatedQuotes: 0,
  };

  // ── Stage 1: deterministic gates ──────────────────────────────────────────
  const gates = applyGates(candidate, rubric, constraints);
  path.push('gates');
  const gatesMs = lap();

  if (!gates.passed) {
    const outcome = decide({
      rubric,
      gates,
      weightedScore: 0,
      verifiedQuotes: 0,
    });
    // The knockout id is the actionable part: a rubric whose single knockout
    // rejects 90% of a sourced list is more likely mis-compiled than the list
    // is bad, and that is only visible if the id is logged per rejection.
    logInfo('agentic_stage_gates_failed', {
      name,
      stage: 'gates',
      decision: outcome.decision,
      failedKnockouts: gates.failures.map((f) => f.knockoutId),
      firstFailure: gates.failures[0]
        ? `${gates.failures[0].requirement}: ${gates.failures[0].detail}`
        : undefined,
      // Checks that could not be evaluated at all. A high count here means the
      // profile data is thin, not that the candidate is unqualified.
      indeterminate: gates.indeterminate.length,
      gatesMs,
      llmCalls: 0,
      totalMs: Date.now() - started,
    });
    return {
      ...base,
      ...outcome,
      stage: outcome.stage,
      gates,
      usage,
      durationMs: Date.now() - started,
    };
  }

  // ── Stage 3: evidence extraction and verification ─────────────────────────
  const evidence = await extractEvidence(candidate, rubric);
  addUsage(usage, evidence.usage);
  path.push('evidence');
  const evidenceMs = lap();

  if (!evidence.ok) {
    const outcome = decide({
      rubric,
      gates,
      weightedScore: 0,
      verifiedQuotes: 0,
      stageFailure: 'evidence extraction failed',
    });
    // A stage failure is an UNCERTAIN, not a rejection on the merits. Warn so
    // it is distinguishable from a candidate who was genuinely screened out —
    // a run where this climbs is a provider or prompt problem, not a sourcing
    // problem, and the two need very different responses.
    logWarn('agentic_stage_evidence_failed', {
      name,
      stage: 'evidence',
      decision: outcome.decision,
      evidenceMs,
      llmCalls: evidence.usage.calls,
      totalMs: Date.now() - started,
    });
    return { ...base, ...outcome, gates, usage, durationMs: Date.now() - started };
  }

  base.findings = evidence.findings;
  base.verifiedQuotes = evidence.verifiedCount;
  base.fabricatedQuotes = evidence.fabricatedCount;

  // Fabrication is the leading indicator that a model has started inventing
  // support, so it is surfaced per candidate here as well as counted in the
  // campaign total — by the time only the aggregate moves, a whole run is
  // already contaminated.
  logInfo('agentic_stage_evidence', {
    name,
    stage: 'evidence',
    findings: evidence.findings.length,
    verifiedQuotes: evidence.verifiedCount,
    fabricatedQuotes: evidence.fabricatedCount,
    // Requirements the model actually found support for, against the number
    // the rubric asks about. A candidate rejected with 1-of-6 addressed was
    // barely evaluated; one rejected with 6-of-6 was genuinely assessed.
    requirementsAddressed: evidence.findings.filter((f) => f.addressed).length,
    requirementsTotal: rubric.competencies.length,
    evidenceMs,
    llmCalls: evidence.usage.calls,
  });

  // ── Stage 4: adjudication ─────────────────────────────────────────────────
  const adjudicated = await adjudicate(evidence.findings, rubric);
  addUsage(usage, adjudicated.usage);
  path.push('adjudicate');
  const adjudicateMs = lap();

  if (!adjudicated.ok || !adjudicated.adjudication) {
    const outcome = decide({
      rubric,
      gates,
      weightedScore: 0,
      verifiedQuotes: evidence.verifiedCount,
      stageFailure: 'adjudication failed',
    });
    logWarn('agentic_stage_adjudication_failed', {
      name,
      stage: 'adjudication',
      decision: outcome.decision,
      adjudicateMs,
      llmCalls: adjudicated.usage.calls,
      totalMs: Date.now() - started,
    });
    return { ...base, ...outcome, gates, usage, durationMs: Date.now() - started };
  }

  base.weightedScore = adjudicated.weightedScore;

  // ── Stage 5: challenge, but only where it can change the answer ───────────
  //
  // The challenger exists to catch false positives, so it runs on candidates
  // heading for a PASS or sitting near the line. Running it on a clear
  // rejection cannot change the outcome and would double the cost of the
  // cheapest decisions in the batch.
  const provisional = decide({
    rubric,
    gates,
    adjudication: adjudicated.adjudication,
    weightedScore: adjudicated.weightedScore,
    verifiedQuotes: evidence.verifiedCount,
  });

  let challengeResult: ChallengeResult | undefined;
  let challengeMs = 0;
  if (provisional.decision !== 'REJECT') {
    challengeResult = await challenge(candidate, evidence.findings, rubric);
    addUsage(usage, challengeResult.usage);
    path.push('challenge');
    challengeMs = lap();

    // `discarded` is the challenger's own fabrication rate: objections thrown
    // out because the quote backing them was not in the profile. A challenger
    // inventing objections silently suppresses good candidates, which is the
    // harder failure to notice because it looks like diligence.
    logInfo('agentic_stage_challenge', {
      name,
      stage: 'challenge',
      provisional: provisional.decision,
      verifiedFatal: challengeResult.verifiedFatal,
      verifiedSerious: challengeResult.verifiedSerious,
      discardedObjections: challengeResult.discarded,
      challengeMs,
      llmCalls: challengeResult.usage.calls,
    });
  } else {
    path.push('challenge:skipped');
  }

  // ── Stage 6: final decision ───────────────────────────────────────────────
  const outcome = decide({
    rubric,
    gates,
    adjudication: adjudicated.adjudication,
    weightedScore: adjudicated.weightedScore,
    challenge: challengeResult,
    verifiedQuotes: evidence.verifiedCount,
  });
  path.push('decide');

  const totalMs = Date.now() - started;
  // Whether the challenger actually changed the answer is the single number
  // that says if stage 5 is earning its cost. It is only computable here,
  // where both the pre- and post-challenge decisions exist.
  const overturned = provisional.decision !== outcome.decision;

  logInfo('agentic_candidate_decided', {
    name,
    decision: outcome.decision,
    stage: outcome.stage,
    confidence: outcome.confidence,
    weightedScore: adjudicated.weightedScore,
    provisional: provisional.decision,
    overturnedByChallenger: overturned,
    verifiedQuotes: evidence.verifiedCount,
    fabricatedQuotes: evidence.fabricatedCount,
    path: path.join('→'),
    timings: { gatesMs, evidenceMs, adjudicateMs, challengeMs },
    totalMs,
    llmCalls: usage.calls,
    tokens: usage.promptTokens + usage.completionTokens,
    usd: Number(usage.usd.toFixed(5)),
  });

  if (overturned) {
    logWarn('agentic_challenger_overturned', {
      name,
      from: provisional.decision,
      to: outcome.decision,
      verifiedFatal: challengeResult?.verifiedFatal ?? 0,
      verifiedSerious: challengeResult?.verifiedSerious ?? 0,
      reason: outcome.reason,
    });
  }

  return {
    ...base,
    ...outcome,
    gates,
    adjudication: adjudicated.adjudication,
    challengeResult,
    usage,
    durationMs: totalMs,
  };
}
