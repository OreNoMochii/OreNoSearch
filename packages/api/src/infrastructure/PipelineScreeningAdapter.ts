import { ScreeningStrategy, ScreenedCandidate, ScreeningOptions, ScreeningResult } from '../domain/ports';
import { retrievalPipelineService } from '../services/RetrievalPipelineService';
import { logInfo, logWarn, logError } from '../utils/logger';
import { recordBatchProgress } from '../controllers/OutreachController';

export class PipelineScreeningAdapter implements ScreeningStrategy {
    readonly name = 'pipeline';

    async screen(jd: string, candidates: readonly ScreenedCandidate[], opts: ScreeningOptions): Promise<readonly ScreeningResult[]> {
        if (!(await retrievalPipelineService.isHealthy())) {
            logWarn('pipeline_unhealthy_falling_back');
            return [];
        }

        try {
            const result = await retrievalPipelineService.search(
                jd,
                opts.topN ?? 700,
                opts.topK ?? 300,
                opts.companyName,
                opts.model,
                opts.minExp,
                opts.maxExp,
            );

            if (!result || result.candidates.length === 0) {
                logWarn('pipeline_returned_nothing_falling_back');
                return [];
            }

            recordBatchProgress(opts.batchId, result.meta.total_retrieved);
            
            // For pipeline, the result candidates ARE the passed candidates. 
            // In Orchestrator, we need to map them back to ScreeningResult format.
            return result.candidates.map(c => ({
                profileUrl: c.profile_url,
                verdict: 'PASS',
                reasoning: `Audit Fit Score: ${c.audit_fit_score}/5`,
                // Pipeline returns fully populated candidates, so we inject them into a special field
                // or the orchestrator will fetch them. We can augment ScreeningResult to include full candidate data.
                _fullCandidateData: c
            }));
        } catch (err) {
            logError('pipeline_search_failed', err as Error);
            return [];
        }
    }
}
