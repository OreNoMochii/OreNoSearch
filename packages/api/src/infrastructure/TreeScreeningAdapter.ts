import path from 'path';
import { runPython } from '../utils/python_runner';
import { ScreeningStrategy, ScreenedCandidate, ScreeningOptions, ScreeningResult } from '../domain/ports';
import { logInfo, logError } from '../utils/logger';

const PY_TREE_SCORER = path.resolve(__dirname, '../../../../machine_learning/tree_scorer/jd_tree_scorer.py');

export class TreeScreeningAdapter implements ScreeningStrategy {
    readonly name = 'tree';

    async screen(jd: string, candidates: readonly ScreenedCandidate[], opts: ScreeningOptions): Promise<readonly ScreeningResult[]> {
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
                    companyName: 'Internal', // Defaulted or passed via opts, though currently 'tree' strategy doesn't pass company in opts easily
                    candidates,
                    topK: opts.treeTopK ?? 1000,
                },
            });

            if (parsed.error) {
                logError('tree_scorer_error', new Error(parsed.error));
                return [];
            }

            const results = parsed.candidates ?? [];
            return results.map(r => ({
                profileUrl: r.profile_url,
                verdict: 'PASS',
                reasoning: `Tree Score: ${r.tree_score.toFixed(2)} | Lang: ${r.lang_infer_score}/3`
            }));
        } catch (err) {
            logError('tree_scorer_failed', err as Error);
            return [];
        }
    }
}
