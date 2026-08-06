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

  const base = {
    profileUrl: candidate.profileUrl,
    findings: [] as VerifiedFinding[],
    weightedScore: 0,
    verifiedQuotes: 0,
    fabricatedQuotes: 0,
  };

  // ── Stage 1: deterministic gates ──────────────────────────────────────────
  const gates = applyGates(candidate, rubric, constraints);
  if (!gates.passed) {
    const outcome = decide({
      rubric,
      gates,
      weightedScore: 0,
      verifiedQuotes: 0,
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

  if (!evidence.ok) {
    const outcome = decide({
      rubric,
      gates,
      weightedScore: 0,
      verifiedQuotes: 0,
      stageFailure: 'evidence extraction failed',
    });
    return { ...base, ...outcome, gates, usage, durationMs: Date.now() - started };
  }

  base.findings = evidence.findings;
  base.verifiedQuotes = evidence.verifiedCount;
  base.fabricatedQuotes = evidence.fabricatedCount;

  // ── Stage 4: adjudication ─────────────────────────────────────────────────
  const adjudicated = await adjudicate(evidence.findings, rubric);
  addUsage(usage, adjudicated.usage);

  if (!adjudicated.ok || !adjudicated.adjudication) {
    const outcome = decide({
      rubric,
      gates,
      weightedScore: 0,
      verifiedQuotes: evidence.verifiedCount,
      stageFailure: 'adjudication failed',
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
  if (provisional.decision !== 'REJECT') {
    challengeResult = await challenge(candidate, evidence.findings, rubric);
    addUsage(usage, challengeResult.usage);
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

  return {
    ...base,
    ...outcome,
    gates,
    adjudication: adjudicated.adjudication,
    challengeResult,
    usage,
    durationMs: Date.now() - started,
  };
}
