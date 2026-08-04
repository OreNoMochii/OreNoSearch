import path from 'path';
import { runPython } from '../utils/python_runner';
import {
  ScreeningStrategy,
  ScreenedCandidate,
  ScreeningOptions,
  ScreeningResult,
  ProgressReporter,
  nullProgressReporter,
} from '../domain/ports';
import { saveScreeningResult } from '../repositories/postgres_repo';
import { logInfo, logWarn, logError } from '../utils/logger';

const PY_TREE_SCORER = path.resolve(
  __dirname,
  '../../../../machine_learning/tree_scorer/jd_tree_scorer.py',
);

/** Minimum tree score for a candidate to advance. */
export const TREE_PASS_THRESHOLD = 0.5;

export interface TreeScore {
  profileUrl: string;
  treeScore: number;
  langScore: number;
}

export class TreeScreeningAdapter implements ScreeningStrategy {
  readonly name = 'tree';

  constructor(private readonly progress: ProgressReporter = nullProgressReporter) {}

  /**
   * Runs the scorer and returns raw scores, so callers that need the ranking
   * (the hybrid engine) can use it without re-deriving verdicts from strings.
   */
  async score(
    jd: string,
    candidates: readonly ScreenedCandidate[],
    opts: ScreeningOptions,
  ): Promise<readonly TreeScore[]> {
    logInfo('tree_scorer_started', { count: candidates.length || 'ALL' });

    try {
      const parsed = await runPython<{
        error?: string;
        candidates?: Array<{
          profile_url: string;
          name: string;
          current_company?: string;
          tree_score: number;
          lang_infer_score: number;
        }>;
      }>({
        scriptPath: PY_TREE_SCORER,
        args: ['--json'],
        stdinPayload: {
          jd,
          // The scorer uses this for same-company exclusion. It was previously
          // hardcoded to 'Internal', which silently disabled that check.
          companyName: opts.companyName,
          candidates,
          topK: opts.treeTopK ?? 1000,
        },
      });

      if (parsed.error) {
        logError('tree_scorer_error', new Error(parsed.error));
        return [];
      }

      const scores = (parsed.candidates ?? []).map((r) => ({
        profileUrl: r.profile_url,
        treeScore: r.tree_score,
        langScore: r.lang_infer_score,
      }));

      logInfo('tree_scorer_complete', {
        scored: scores.length,
        passing: scores.filter((s) => s.treeScore >= TREE_PASS_THRESHOLD).length,
        threshold: TREE_PASS_THRESHOLD,
      });

      return scores;
    } catch (err) {
      logError('tree_scorer_failed', err);
      return [];
    } finally {
      this.progress.report(opts.batchId, candidates.length);
    }
  }

  async screen(
    jd: string,
    candidates: readonly ScreenedCandidate[],
    opts: ScreeningOptions,
  ): Promise<readonly ScreeningResult[]> {
    const scores = await this.score(jd, candidates, opts);

    // The 0.5 threshold was dropped during the port extraction: every scored
    // candidate was returned with verdict 'PASS', so the model's output was
    // computed and then discarded. Restored here.
    const results: ScreeningResult[] = scores.map((s) => ({
      profileUrl: s.profileUrl,
      verdict: s.treeScore >= TREE_PASS_THRESHOLD ? ('PASS' as const) : ('REJECT' as const),
      reasoning: `Tree Score: ${s.treeScore.toFixed(3)} | Lang: ${s.langScore}/3`,
    }));

    // Persist verdicts so the dedup path can skip re-screening these later.
    await Promise.all(
      results.map((r) =>
        saveScreeningResult(
          r.profileUrl,
          opts.companyName,
          opts.jobName,
          r.verdict,
          r.reasoning,
        ).catch((err: unknown) =>
          logWarn('tree_verdict_persist_failed', {
            profileUrl: r.profileUrl,
            message: (err as Error).message,
          }),
        ),
      ),
    );

    return results;
  }
}
