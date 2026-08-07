import {
  ScreeningStrategy,
  ScreenedCandidate,
  ScreeningOptions,
  ScreeningResult,
  ProgressReporter,
  nullProgressReporter,
} from '../domain/ports';
import type { CompanyIntel } from '../repositories/postgres_repo';
import { screeningAgent } from '../services/ScreeningAgent';
import { logInfo, logError, logWarn, logSkipped } from '../utils/logger';
import { saveScreeningResultsBatch, getCompanyIntelBatch } from '../repositories/postgres_repo';

export class LlmScreeningAdapter implements ScreeningStrategy {
  readonly name = 'llm';

  constructor(private readonly progress: ProgressReporter = nullProgressReporter) {}

  /**
   * Batch-loads employer intel for the candidate set in a single query.
   * Returns an empty map when the feature is off or the lookup fails —
   * missing context degrades screening quality but must never fail a campaign.
   */
  private async loadCompanyIntel(
    candidates: readonly ScreenedCandidate[],
    opts: ScreeningOptions,
  ): Promise<ReadonlyMap<string, CompanyIntel>> {
    if (opts.useCompanyIntel === false) return new Map();

    const names = candidates
      .map((c) => c.currentCompany)
      .filter((n): n is string => !!n && n.trim().length > 0);
    if (names.length === 0) return new Map();

    try {
      const intel = await getCompanyIntelBatch(names);
      logInfo('company_intel_loaded', {
        matched: intel.size,
        unique: new Set(names.map((n) => n.toLowerCase())).size,
      });
      return intel;
    } catch (err) {
      logWarn('company_intel_failed', { message: (err as Error).message });
      return new Map();
    }
  }

  async screen(
    jd: string,
    candidates: readonly ScreenedCandidate[],
    opts: ScreeningOptions,
  ): Promise<readonly ScreeningResult[]> {
    const isNvidia = opts.model.startsWith('nvidia:');
    const MAX_CONCURRENCY = isNvidia ? 4 : 10;
    const MIN_CONCURRENCY = 1;
    const RAMP_UP_THRESHOLD = 15;
    let currentConcurrency = isNvidia ? 2 : 5;

    // B30: restore company intel. The pre-refactor OutreachService loaded
    // this and attached it to each candidate before screening; the port
    // extraction dropped it, leaving getCompanyIntelBatch with zero call
    // sites and the UI's Company Intel toggle doing nothing at all.
    const companyIntel = await this.loadCompanyIntel(candidates, opts);

    const total = candidates.length;
    const startedAt = Date.now();
    logInfo('llm_audit_started', {
      total,
      model: opts.model,
      concurrency: currentConcurrency,
      companyIntelMatched: companyIntel.size,
      adjacentRoles: opts.adjacentRoles ? opts.adjacentRoles : undefined,
    });

    let processed = 0;
    let consecutiveSuccesses = 0;
    let rateLimitHits = 0;
    // Verdicts the grounding check in ScreeningAgent flipped from PASS to
    // REJECT because the model's supporting quotes were not in the profile.
    // Per-candidate these already warn; without a running total there is no
    // way to see that a model is fabricating on most of the batch.
    let overturnedByGrounding = 0;
    let errored = 0;

    const finalResults: ScreeningResult[] = [];

    while (processed < total) {
      const waveSize = Math.min(currentConcurrency, total - processed);
      const wave = candidates.slice(processed, processed + waveSize);

      const waveResults = await Promise.allSettled(
        wave.map(async (candidate) => {
          try {
            const intel = candidate.currentCompany
              ? companyIntel.get(candidate.currentCompany.trim().toLowerCase())
              : undefined;

            const payload = intel
              ? {
                  ...candidate,
                  _companyIntel:
                    `[Company Intel] ${intel.company_type} | Size: ${intel.size_band} | ` +
                    `Flight Risk: ${intel.flight_risk} | Compensation: ${intel.compensation}`,
                }
              : candidate;

            const { isMatch, reasoning, rateLimited } = await screeningAgent.verificationAgent(
              jd,
              payload,
              opts.model,
              opts.adjacentRoles ?? '',
            );

            if (rateLimited) return { status: 'rate_limited' as const, candidate };

            // The verdict is persisted once per wave rather than once per
            // candidate — see the batch write below.
            if (!isMatch) void logSkipped(candidate, 'Verification Agent', reasoning);
            return {
              status: 'success' as const,
              result: {
                profileUrl: candidate.profileUrl,
                verdict: isMatch ? ('PASS' as const) : ('REJECT' as const),
                reasoning,
              },
            };
          } catch (err) {
            errored++;
            logError('candidate_screening_failed', err as Error, { name: candidate.name });
            return { status: 'error' as const, candidate };
          } finally {
            this.progress.report(opts.batchId);
          }
        }),
      );

      const waveRateLimited = waveResults.some(
        (r) => r.status === 'fulfilled' && r.value.status === 'rate_limited',
      );

      const waveVerdicts: ScreeningResult[] = [];
      for (const r of waveResults) {
        if (r.status === 'fulfilled' && r.value.status === 'success') {
          finalResults.push(r.value.result);
          waveVerdicts.push(r.value.result);
          // ScreeningAgent overturns a PASS when the model's cited quotes are
          // absent from the profile, and signals it in the reasoning prefix.
          // Matching on that string is brittle, but the alternative is
          // widening the ScreeningResult contract for a counter.
          if (r.value.result.reasoning.startsWith('Verdict overturned:')) {
            overturnedByGrounding++;
          }
        }
      }

      // One statement per wave instead of one per candidate. A failure here
      // costs re-screening on the next run, so it is logged rather than thrown.
      if (waveVerdicts.length > 0) {
        await saveScreeningResultsBatch(waveVerdicts, opts.companyName, opts.jobName).catch(
          (err: unknown) => {
            logWarn('llm_verdict_persist_failed', {
              count: waveVerdicts.length,
              message: (err as Error).message,
            });
          },
        );
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

      // A large batch is otherwise silent between start and finish. The rate
      // is measured over the whole run rather than the last wave so the ETA
      // does not swing wildly every time concurrency is halved by a 429.
      const elapsedMs = Date.now() - startedAt;
      const perCandidate = elapsedMs / Math.max(processed, 1);
      logInfo('llm_audit_progress', {
        processed,
        total,
        pct: Math.round((processed / total) * 100),
        passedSoFar: finalResults.filter((r) => r.verdict === 'PASS').length,
        overturnedByGrounding,
        concurrency: currentConcurrency,
        etaSeconds: Math.round((perCandidate * (total - processed)) / 1000),
      });
    }

    const passedCount = finalResults.filter((r) => r.verdict === 'PASS').length;
    const elapsedMs = Date.now() - startedAt;

    logInfo('llm_audit_complete', {
      total,
      screened: finalResults.length,
      passed: passedCount,
      rejected: finalResults.length - passedCount,
      passRate: finalResults.length ? Number((passedCount / finalResults.length).toFixed(3)) : 0,
      // Fabricated-evidence overturns. If this approaches the rejection count
      // the model is not screening, it is hallucinating and being caught —
      // a signal to change model rather than to tune the prompt.
      overturnedByGrounding,
      // Candidates that produced no verdict at all: neither passed nor
      // rejected, just lost. Silent shrinkage of a shortlist is worse than a
      // visible failure.
      errored,
      unaccounted: total - finalResults.length,
      rateLimitHits,
      finalConcurrency: currentConcurrency,
      elapsedSeconds: Math.round(elapsedMs / 1000),
      msPerCandidate: Math.round(elapsedMs / Math.max(total, 1)),
      model: opts.model,
    });

    return finalResults;
  }
}
