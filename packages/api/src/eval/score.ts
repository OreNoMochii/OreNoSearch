/**
 * score.ts — metrics for a screening run.
 *
 * The headline number is PRECISION ON PASS: of the candidates the system handed
 * to a recruiter, what fraction were actually a fit. That is the metric the
 * product cares about, because a false positive wastes a human's time and a
 * false negative merely costs a candidate nobody knew about.
 *
 * Accuracy is deliberately not reported. With a pass rate around 30% a screener
 * that rejects everyone scores 70% accuracy, which makes the number worse than
 * useless as a target.
 *
 * Abstention is scored separately rather than folded into the errors. An
 * UNCERTAIN verdict is not a mistake — it is the system declining to guess, and
 * it is how precision is bought. But it is not free either: abstaining on
 * everything would give perfect precision and no value, so the abstention rate
 * has to be read next to the precision it purchased.
 */

export type Predicted = 'PASS' | 'REJECT' | 'UNCERTAIN';
export type Actual = 'FIT' | 'NOT_FIT';

export interface ScoredPair {
  profileUrl: string;
  predicted: Predicted;
  actual: Actual;
  /** Label trustworthiness, 0-1. Weak labels contribute proportionally. */
  weight: number;
}

export interface EvalMetrics {
  /** Pairs considered, excluding abstentions. */
  decided: number;
  abstained: number;
  total: number;

  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;

  /** THE metric: of everything we said PASS to, how much was actually a fit. */
  precisionOnPass: number;
  /** Of everything that was a fit, how much did we find. Bounded above by the
   *  label set — rejected candidates are never labelled, so real recall is
   *  lower than this reports. */
  recall: number;
  f1: number;
  /** Fraction routed to a human instead of decided. */
  abstentionRate: number;

  /** Fraction of PASS verdicts that a human would overturn. The inverse of
   *  precision, stated the way a recruiter experiences it. */
  wastedReviewRate: number;
}

export interface CostMetrics {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  candidates: number;
  callsPerCandidate: number;
  tokensPerCandidate: number;
  /** Quotes the models produced that were not in the source profile. A rising
   *  count means a model or prompt has started inventing evidence. */
  fabricatedQuotes: number;
  fabricationRate: number;
}

const safeDiv = (num: number, den: number): number => (den === 0 ? 0 : num / den);

export function scoreRun(pairs: readonly ScoredPair[]): EvalMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let abstainedWeight = 0;
  let totalWeight = 0;

  for (const p of pairs) {
    const w = p.weight;
    totalWeight += w;

    if (p.predicted === 'UNCERTAIN') {
      abstainedWeight += w;
      continue;
    }

    const said = p.predicted === 'PASS';
    const is = p.actual === 'FIT';

    if (said && is) tp += w;
    else if (said && !is) fp += w;
    else if (!said && !is) tn += w;
    else fn += w;
  }

  const precisionOnPass = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);

  return {
    decided: Math.round(tp + fp + tn + fn),
    abstained: Math.round(abstainedWeight),
    total: Math.round(totalWeight),
    truePositives: Math.round(tp),
    falsePositives: Math.round(fp),
    trueNegatives: Math.round(tn),
    falseNegatives: Math.round(fn),
    precisionOnPass,
    recall,
    f1: safeDiv(2 * precisionOnPass * recall, precisionOnPass + recall),
    abstentionRate: safeDiv(abstainedWeight, totalWeight),
    wastedReviewRate: safeDiv(fp, tp + fp),
  };
}

export function scoreCost(runs: {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  candidates: number;
  fabricatedQuotes: number;
  totalQuotes: number;
}): CostMetrics {
  return {
    llmCalls: runs.llmCalls,
    promptTokens: runs.promptTokens,
    completionTokens: runs.completionTokens,
    candidates: runs.candidates,
    callsPerCandidate: safeDiv(runs.llmCalls, runs.candidates),
    tokensPerCandidate: safeDiv(runs.promptTokens + runs.completionTokens, runs.candidates),
    fabricatedQuotes: runs.fabricatedQuotes,
    fabricationRate: safeDiv(runs.fabricatedQuotes, runs.totalQuotes),
  };
}

/** Human-readable report. */
export function formatReport(label: string, metrics: EvalMetrics, cost?: CostMetrics): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines = [
    ``,
    `── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`,
    ``,
    `  precision@PASS   ${pct(metrics.precisionOnPass).padStart(7)}   ← the one that matters`,
    `  recall           ${pct(metrics.recall).padStart(7)}   (upper bound; rejects are unlabelled)`,
    `  F1               ${pct(metrics.f1).padStart(7)}`,
    `  abstention       ${pct(metrics.abstentionRate).padStart(7)}   routed to human review`,
    `  wasted review    ${pct(metrics.wastedReviewRate).padStart(7)}   of PASSes a human would overturn`,
    ``,
    `  TP ${metrics.truePositives}   FP ${metrics.falsePositives}   TN ${metrics.trueNegatives}   FN ${metrics.falseNegatives}`,
    `  decided ${metrics.decided} / abstained ${metrics.abstained} / total ${metrics.total}`,
  ];

  if (cost) {
    lines.push(
      ``,
      `  LLM calls/candidate   ${cost.callsPerCandidate.toFixed(2)}`,
      `  tokens/candidate      ${Math.round(cost.tokensPerCandidate)}`,
      `  fabricated quotes     ${cost.fabricatedQuotes} (${pct(cost.fabricationRate)} of all quotes)`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Compares a candidate configuration against a baseline.
 *
 * Returns whether the change is an improvement on the metric that matters,
 * which is what a CI gate should key on. A precision gain bought with a large
 * abstention increase is flagged rather than celebrated: at the limit, a system
 * that abstains on everything has perfect precision and zero usefulness.
 */
export function compare(
  baseline: EvalMetrics,
  candidate: EvalMetrics,
  opts: { maxAbstentionIncrease?: number } = {},
): { improved: boolean; summary: string } {
  const maxAbstention = opts.maxAbstentionIncrease ?? 0.15;
  const precisionDelta = candidate.precisionOnPass - baseline.precisionOnPass;
  const abstentionDelta = candidate.abstentionRate - baseline.abstentionRate;
  const recallDelta = candidate.recall - baseline.recall;

  const pct = (n: number): string => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}pp`;
  const improved = precisionDelta > 0 && abstentionDelta <= maxAbstention;

  const summary = [
    `precision@PASS ${pct(precisionDelta)}`,
    `recall ${pct(recallDelta)}`,
    `abstention ${pct(abstentionDelta)}`,
    improved
      ? 'VERDICT: improvement'
      : precisionDelta <= 0
        ? 'VERDICT: no precision gain'
        : `VERDICT: precision gained but abstention rose more than ${(maxAbstention * 100).toFixed(0)}pp`,
  ].join('  |  ');

  return { improved, summary };
}
