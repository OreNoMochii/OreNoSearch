/**
 * adjudicator.ts — Stage 4: score the rubric using only verified evidence.
 *
 * The adjudicator never sees the raw profile. It sees the rubric and the quotes
 * that survived verification, and nothing else.
 *
 * That constraint is the design. Given a full resume, a model reasons from
 * impressions — a prestigious employer, a confident summary, a familiar job
 * title — and then finds evidence to justify the impression it already formed.
 * Given only verified quotes, it has nothing to reason from except what the
 * candidate demonstrably wrote. Unevidenced strength becomes unscoreable rather
 * than merely unproven.
 *
 * Self-consistency: when the weighted score lands near the decision boundary,
 * the call is repeated and the scores are averaged. Sampling several times far
 * from the boundary changes nothing and costs money, so it is only done where
 * it can change the answer.
 */
import { Adjudication, type JdRubric } from './schemas';
import { callStage, addUsage, emptyUsage, type TokenUsage } from './llm';
import { totalWeight } from './rubric';
import type { VerifiedFinding } from './evidence';
import { config } from '../config';

const SYSTEM = `You score a candidate against a fixed rubric.

You are shown ONLY evidence that has already been verified as genuine quotes
from the candidate's profile. Anything the candidate did not demonstrably write
is not available to you, by design.

## Scoring, per competency

  0 — no evidence at all
  1 — tangential; the evidence touches the area but does not demonstrate it
  2 — partial; demonstrated, but narrower or shallower than the requirement
  3 — solid; clearly meets the requirement
  4 — strong; clearly exceeds it

Score 0 when there is no evidence. Do NOT award a middling score to express
uncertainty — "no evidence" and "weak evidence" are different findings and
collapsing them hides which one you actually have.

## Knockouts

For each must-have return satisfied = true, false, or null.
Use null when the evidence genuinely does not say. Guessing here is worse than
abstaining: a null routes the candidate to a human, a wrong boolean does not.

## Rules

- Base every score on the quoted evidence. Do not infer from employer prestige,
  job title, or what someone in this role "would usually" have done.
- Absence of evidence is not evidence of absence — but it is also not evidence
  of presence, and you score presence.
- Be concise in rationales. One sentence, citing which quote drove the score.

## Output

{
  "knockouts": [ { "knockout_id": "...", "satisfied": true, "rationale": "..." } ],
  "competencies": [ { "requirement_id": "...", "score": 3, "rationale": "..." } ],
  "seniority_assessment": "...",
  "estimated_years": <number or null>
}`;

export interface AdjudicationResult {
  ok: boolean;
  adjudication?: Adjudication;
  /** Weighted competency score normalised to 0-1. */
  weightedScore: number;
  /** Number of samples taken. >1 means the score was near the boundary. */
  samples: number;
  usage: TokenUsage;
}

function renderEvidence(findings: readonly VerifiedFinding[]): string {
  return findings
    .map((f) => {
      const quotes =
        f.verifiedQuotes.length > 0
          ? f.verifiedQuotes.map((q) => `    • "${q}"`).join('\n')
          : '    (no verified evidence)';
      return `- ${f.requirementId}: ${f.requirement}\n${quotes}`;
    })
    .join('\n');
}

/** Normalises competency scores to 0-1 against the rubric's own weights. */
export function computeWeightedScore(adjudication: Adjudication, rubric: JdRubric): number {
  const weights = new Map(rubric.competencies.map((c) => [c.id, c.weight || 0]));
  const denominator = totalWeight(rubric) * 4; // 4 is the max per-competency score
  if (denominator === 0) return 0;

  let numerator = 0;
  for (const score of adjudication.competencies) {
    const weight = weights.get(score.requirement_id);
    // Scores for ids not in the rubric are ignored rather than counted: they
    // would otherwise inflate the numerator against a fixed denominator.
    if (weight === undefined) continue;
    numerator += Math.max(0, Math.min(4, score.score)) * weight;
  }

  return Math.max(0, Math.min(1, numerator / denominator));
}

/** Averages several samples into one adjudication, per requirement id. */
function mergeSamples(samples: readonly Adjudication[]): Adjudication {
  const first = samples[0];
  if (samples.length === 1) return first;

  const scoreBuckets = new Map<string, number[]>();
  for (const sample of samples) {
    for (const c of sample.competencies) {
      const bucket = scoreBuckets.get(c.requirement_id) ?? [];
      bucket.push(c.score);
      scoreBuckets.set(c.requirement_id, bucket);
    }
  }

  const competencies = first.competencies.map((c) => {
    const bucket = scoreBuckets.get(c.requirement_id) ?? [c.score];
    const mean = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    return { ...c, score: Math.round(mean * 100) / 100 };
  });

  // Knockouts take the most conservative reading across samples: a single
  // sample seeing a violation is enough to treat it as one, and a single null
  // is enough to make it indeterminate. Majority-voting a knockout would let
  // two optimistic samples overrule one that spotted a real disqualifier.
  const knockouts = first.knockouts.map((k) => {
    const verdicts = samples
      .flatMap((s) => s.knockouts)
      .filter((x) => x.knockout_id === k.knockout_id)
      .map((x) => x.satisfied);
    if (verdicts.some((v) => v === false)) return { ...k, satisfied: false };
    if (verdicts.some((v) => v === null)) return { ...k, satisfied: null };
    return { ...k, satisfied: true };
  });

  return { ...first, competencies, knockouts };
}

export async function adjudicate(
  findings: readonly VerifiedFinding[],
  rubric: JdRubric,
): Promise<AdjudicationResult> {
  const usage = emptyUsage();

  const knockoutBlock =
    rubric.knockouts.length > 0
      ? rubric.knockouts.map((k) => `- ${k.id}: ${k.requirement}`).join('\n')
      : '(none)';
  const competencyBlock = rubric.competencies
    .map((c) => `- ${c.id} (weight ${c.weight}): ${c.requirement}`)
    .join('\n');

  const user = `ROLE
${rubric.role_summary || rubric.role_title}
Seniority band: ${rubric.seniority_band}

MUST-HAVES
${knockoutBlock}

COMPETENCIES
${competencyBlock}

VERIFIED EVIDENCE
${renderEvidence(findings)}

Score the candidate.`;

  const first = await callStage({
    role: 'adjudicator',
    system: SYSTEM,
    user,
    schema: Adjudication,
    maxTokens: 3072,
  });
  addUsage(usage, first.usage);

  if (!first.ok || !first.data) {
    return { ok: false, weightedScore: 0, samples: 0, usage };
  }

  let score = computeWeightedScore(first.data, rubric);
  const collected: Adjudication[] = [first.data];

  // ── Self-consistency, only where it can change the outcome ────────────────
  const distanceFromThreshold = Math.abs(score - config.SCREENING_PASS_THRESHOLD);
  if (distanceFromThreshold <= config.SCREENING_UNCERTAIN_BAND) {
    const extra = Math.max(0, config.SCREENING_CONSISTENCY_SAMPLES - 1);
    for (let i = 0; i < extra; i++) {
      // Temperature must be non-zero here or every sample is identical and the
      // exercise is pointless. Kept low so the samples stay sane.
      const sample = await callStage({
        role: 'adjudicator',
        system: SYSTEM,
        user,
        schema: Adjudication,
        maxTokens: 3072,
        temperature: 0.3,
        seedOffset: i + 1,
      });
      addUsage(usage, sample.usage);
      if (sample.ok && sample.data) collected.push(sample.data);
    }
    const merged = mergeSamples(collected);
    score = computeWeightedScore(merged, rubric);
    return {
      ok: true,
      adjudication: merged,
      weightedScore: score,
      samples: collected.length,
      usage,
    };
  }

  return { ok: true, adjudication: first.data, weightedScore: score, samples: 1, usage };
}
