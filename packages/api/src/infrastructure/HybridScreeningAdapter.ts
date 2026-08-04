import {
  ScreeningStrategy,
  ScreenedCandidate,
  ScreeningOptions,
  ScreeningResult,
} from '../domain/ports';
import { TreeScreeningAdapter, TREE_PASS_THRESHOLD } from './TreeScreeningAdapter';
import { LlmScreeningAdapter } from './LlmScreeningAdapter';
import { logInfo } from '../utils/logger';

/**
 * Tree pre-filter followed by LLM audit — the UI's "Hybrid" engine.
 *
 * The composition root previously mapped 'tree_llm' to a bare
 * LlmScreeningAdapter with the comment "Or a dedicated Hybrid adapter", so
 * selecting Hybrid ran a full LLM audit over every candidate. The tree stage
 * exists precisely to avoid that: it is a cheap local model that discards
 * obvious non-matches before any paid LLM call is made.
 *
 * With a 1,000-candidate pool and a typical tree pass rate, this is the
 * difference between ~1,000 LLM calls and a few hundred.
 */
export class HybridScreeningAdapter implements ScreeningStrategy {
  readonly name = 'tree_llm';

  constructor(
    private readonly tree: TreeScreeningAdapter,
    private readonly llm: LlmScreeningAdapter,
  ) {}

  async screen(
    jd: string,
    candidates: readonly ScreenedCandidate[],
    opts: ScreeningOptions,
  ): Promise<readonly ScreeningResult[]> {
    // ── Stage 1: cheap local pre-filter ─────────────────────────────────────
    const scores = await this.tree.score(jd, candidates, opts);

    if (scores.length === 0) {
      // The scorer failed or returned nothing. Falling through to a full LLM
      // audit would silently turn Hybrid into the most expensive engine, so
      // stop instead and let the operator see it in the logs.
      logInfo('hybrid_tree_stage_empty', { batchId: opts.batchId });
      return [];
    }

    const passing = new Set(
      scores.filter((s) => s.treeScore >= TREE_PASS_THRESHOLD).map((s) => s.profileUrl),
    );

    const survivors = candidates.filter((c) => passing.has(c.profileUrl));
    const rejected: ScreeningResult[] = candidates
      .filter((c) => !passing.has(c.profileUrl))
      .map((c) => ({
        profileUrl: c.profileUrl,
        verdict: 'REJECT' as const,
        reasoning: 'Rejected by tree pre-filter (score below threshold)',
      }));

    logInfo('hybrid_prefilter_complete', {
      batchId: opts.batchId,
      scored: candidates.length,
      survivors: survivors.length,
      llmCallsAvoided: candidates.length - survivors.length,
    });

    if (survivors.length === 0) return rejected;

    // ── Stage 2: LLM audit on survivors only ────────────────────────────────
    const audited = await this.llm.screen(jd, survivors, opts);

    // Tree rejections are returned alongside so the caller sees a verdict for
    // every candidate it submitted, not just the ones that reached the LLM.
    return [...audited, ...rejected];
  }
}
