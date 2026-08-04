import { ScreeningStrategy, ScreenedCandidate, ScreeningOptions, ScreeningResult } from '../domain/ports';
import { screeningAgent } from '../services/ScreeningAgent';
import { logInfo, logError, logWarn, logSkipped } from '../utils/logger';
import { recordBatchProgress } from '../controllers/OutreachController';
import { saveScreeningResult } from '../repositories/postgres_repo';

export class LlmScreeningAdapter implements ScreeningStrategy {
    readonly name = 'llm';

    async screen(jd: string, candidates: readonly ScreenedCandidate[], opts: ScreeningOptions): Promise<readonly ScreeningResult[]> {
        const isNvidia = opts.model.startsWith('nvidia:');
        const MAX_CONCURRENCY = isNvidia ? 4 : 10;
        const MIN_CONCURRENCY = 1;
        const RAMP_UP_THRESHOLD = 15;
        let currentConcurrency = isNvidia ? 2 : 5;

        const total = candidates.length;
        logInfo('llm_audit_started', {
            total,
            model: opts.model,
            concurrency: currentConcurrency,
        });

        let processed = 0;
        let consecutiveSuccesses = 0;
        let rateLimitHits = 0;
        
        const finalResults: ScreeningResult[] = [];

        while (processed < total) {
            const waveSize = Math.min(currentConcurrency, total - processed);
            const wave = candidates.slice(processed, processed + waveSize);

            const waveResults = await Promise.allSettled(
                wave.map(async (candidate) => {
                    try {
                        const { isMatch, reasoning, rateLimited } = await screeningAgent.verificationAgent(
                            jd,
                            candidate as any, // Mapped to expected schema
                            opts.model,
                            opts.adjacentRoles ?? '',
                        );

                        if (rateLimited) return { status: 'rate_limited' as const, candidate };

                        if (isMatch) {
                            await saveScreeningResult(candidate.profileUrl, opts.companyName, opts.jobName, 'PASS', reasoning);
                            return { status: 'success' as const, result: { profileUrl: candidate.profileUrl, verdict: 'PASS' as const, reasoning } };
                        } else {
                            await saveScreeningResult(candidate.profileUrl, opts.companyName, opts.jobName, 'REJECT', reasoning);
                            void logSkipped(candidate, 'Verification Agent', reasoning);
                            return { status: 'success' as const, result: { profileUrl: candidate.profileUrl, verdict: 'REJECT' as const, reasoning } };
                        }
                    } catch (err) {
                        logError('candidate_screening_failed', err as Error, { name: candidate.name });
                        return { status: 'error' as const, candidate };
                    } finally {
                        recordBatchProgress(opts.batchId);
                    }
                })
            );

            const waveRateLimited = waveResults.some(
                (r) => r.status === 'fulfilled' && r.value.status === 'rate_limited'
            );

            for (const r of waveResults) {
                if (r.status === 'fulfilled' && r.value.status === 'success' && r.value.result) {
                    finalResults.push(r.value.result);
                }
            }

            if (waveRateLimited) {
                rateLimitHits++;
                const previous = currentConcurrency;
                currentConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(currentConcurrency / 2));
                consecutiveSuccesses = 0;
                if (previous !== currentConcurrency) {
                    logWarn('concurrency_reduced', { from: previous, to: currentConcurrency });
                }
                await new Promise((r) => setTimeout(r, 10_000 + Math.random() * 5_000));
            } else {
                consecutiveSuccesses += waveSize;
                if (consecutiveSuccesses >= RAMP_UP_THRESHOLD && currentConcurrency < MAX_CONCURRENCY) {
                    currentConcurrency = Math.min(MAX_CONCURRENCY, currentConcurrency + 1);
                    consecutiveSuccesses = 0;
                    logInfo('concurrency_increased', { to: currentConcurrency });
                }
                await new Promise((r) => setTimeout(r, 500));
            }

            processed += waveSize;
        }

        logInfo('llm_audit_complete', {
            total,
            passed: finalResults.filter(r => r.verdict === 'PASS').length,
            rateLimitHits,
            finalConcurrency: currentConcurrency,
        });

        return finalResults;
    }
}
