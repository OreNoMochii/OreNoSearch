import { randomUUID } from 'crypto';
import {
  ScreeningStrategy,
  ScreenedCandidate,
  ScreeningOptions,
  ScreeningResult,
  ProgressReporter,
  nullProgressReporter,
} from '../domain/ports';
import { compileRubric } from '../screening/rubric';
import { modelFor } from '../screening/llm';
import { challengerSharesFamily } from '../core/model_catalog';
import { screenCandidate, type CandidateOutcome } from '../screening/pipeline';
import { hashJd, saveAuditBatch, type AuditRow } from '../repositories/screening_repo';
import { saveScreeningResultsBatch } from '../repositories/postgres_repo';
import { config } from '../config';
import { logInfo, logWarn, logError } from '../utils/logger';

/**
 * The agentic screening engine.
 *
 * Replaces one monolithic LLM call per candidate with a funnel: deterministic
 * gates, grounded evidence extraction, adjudication over verified quotes only,
 * an adversarial challenge, and a decision that is allowed to abstain.
 *
 * The engine's contract with the rest of the system is unchanged — it returns
 * PASS/REJECT per candidate — but it now has a third internal outcome.
 * UNCERTAIN candidates are reported as REJECT to the orchestrator so they are
 * never emailed, and recorded as UNCERTAIN in `screening_audit` so they can be
 * pulled into a review queue. Sending someone the system is unsure about is
 * the exact failure this pipeline exists to prevent.
 */
export class AgenticScreeningAdapter implements ScreeningStrategy {
  readonly name = 'agentic' as const;

  constructor(private readonly progress: ProgressReporter = nullProgressReporter) {}

  async screen(
    jd: string,
    candidates: readonly ScreenedCandidate[],
    opts: ScreeningOptions,
  ): Promise<readonly ScreeningResult[]> {
    const runId = randomUUID();
    const jdHash = hashJd(jd);

    // ── Stage 0: compile the rubric once for the whole campaign ─────────────
    const compiled = await compileRubric({
      jdText: jd,
      jobName: opts.jobName,
      companyName: opts.companyName,
    });

    if (!compiled) {
      logError('agentic_rubric_unavailable', new Error('JD compilation failed'), {
        batchId: opts.batchId,
      });
      // Without a rubric there is no bar to screen against. Returning nothing
      // is correct: silently falling back to a different engine would produce
      // results the operator believes came from this one.
      return [];
    }

    if (config.SCREENING_REQUIRE_APPROVED_RUBRIC && !compiled.approved) {
      logWarn('agentic_rubric_not_approved', {
        jdHash,
        batchId: opts.batchId,
        openQuestions: compiled.rubric.open_questions,
      });
      return [];
    }

    // Not fatal, but it quietly removes most of the challenger's value: a model
    // sharing the adjudicator's lineage shares its blind spots, and two models
    // failing the same way is indistinguishable from one being right.
    if (challengerSharesFamily(modelFor('adjudicator'), modelFor('challenger'))) {
      logWarn('challenger_shares_family_with_adjudicator', {
        adjudicator: modelFor('adjudicator'),
        challenger: modelFor('challenger'),
        why: 'shared lineage means shared blind spots — pick a different family',
      });
    }

    logInfo('agentic_screening_started', {
      runId,
      jdHash,
      batchId: opts.batchId,
      candidates: candidates.length,
      rubricFromCache: compiled.fromCache,
      knockouts: compiled.rubric.knockouts.length,
      competencies: compiled.rubric.competencies.length,
      approved: compiled.approved,
    });

    const constraints = {
      minExpYears: opts.minExp,
      maxExpYears: opts.maxExp,
    };

    // Concurrency is bounded by the shared NIM rate limiter inside callStage,
    // so a modest wave size here is about memory and pool pressure rather than
    // provider limits.
    const WAVE = 5;
    const outcomes: CandidateOutcome[] = [];

    for (let i = 0; i < candidates.length; i += WAVE) {
      const wave = candidates.slice(i, i + WAVE);
      const settled = await Promise.allSettled(
        wave.map(async (candidate) => {
          try {
            return await screenCandidate(candidate, compiled.rubric, constraints);
          } finally {
            this.progress.report(opts.batchId);
          }
        }),
      );

      for (const r of settled) {
        if (r.status === 'fulfilled') {
          outcomes.push(r.value);
        } else {
          logError('agentic_candidate_failed', r.reason as Error, { runId });
        }
      }
    }

    await this.persist(runId, jdHash, opts, outcomes);

    const passed = outcomes.filter((o) => o.decision === 'PASS');
    const uncertain = outcomes.filter((o) => o.decision === 'UNCERTAIN');
    const fabrications = outcomes.reduce((n, o) => n + o.fabricatedQuotes, 0);
    const tokens = outcomes.reduce(
      (n, o) => n + o.usage.promptTokens + o.usage.completionTokens,
      0,
    );
    // DeepInfra portion only — NIM is credit/licence based, not per-token.
    const usd = outcomes.reduce((n, o) => n + o.usage.usd, 0);

    logInfo('agentic_screening_complete', {
      runId,
      batchId: opts.batchId,
      screened: outcomes.length,
      passed: passed.length,
      uncertain: uncertain.length,
      rejected: outcomes.length - passed.length - uncertain.length,
      // A rising fabrication count is the leading indicator that a model or a
      // prompt change has started inventing evidence.
      fabricatedQuotes: fabrications,
      llmCalls: outcomes.reduce((n, o) => n + o.usage.calls, 0),
      totalTokens: tokens,
      estimatedUsd: Number(usd.toFixed(4)),
      usdPerCandidate: outcomes.length > 0 ? Number((usd / outcomes.length).toFixed(5)) : 0,
    });

    return outcomes.map((o) => ({
      profileUrl: o.profileUrl,
      // UNCERTAIN is surfaced as REJECT so nobody is contacted on a maybe; the
      // audit row preserves the distinction for the review queue.
      verdict: o.decision === 'PASS' ? ('PASS' as const) : ('REJECT' as const),
      reasoning:
        o.decision === 'UNCERTAIN'
          ? `[NEEDS REVIEW] ${o.reason}`
          : `${o.reason} [stage: ${o.stage}, evidence: ${o.verifiedQuotes} verified]`,
    }));
  }

  /** Writes the audit trail and the verdicts, each in one statement. */
  private async persist(
    runId: string,
    jdHash: string,
    opts: ScreeningOptions,
    outcomes: readonly CandidateOutcome[],
  ): Promise<void> {
    if (outcomes.length === 0) return;

    const auditRows: AuditRow[] = outcomes.map((o) => ({
      runId,
      profileUrl: o.profileUrl,
      jdHash,
      companyName: opts.companyName,
      jobName: opts.jobName,
      decision: o.decision,
      decidedAtStage: o.stage,
      confidence: o.confidence,
      gateResult: o.gates,
      prefilterScore: null,
      evidence: o.findings,
      adjudication: o.adjudication ?? null,
      challenge: o.challengeResult?.challenge ?? null,
      quotesVerified: o.verifiedQuotes,
      quotesUnverified: o.fabricatedQuotes,
      promptTokens: o.usage.promptTokens,
      completionTokens: o.usage.completionTokens,
      llmCalls: o.usage.calls,
      durationMs: o.durationMs,
    }));

    // Audit is diagnostic: losing it must not fail a campaign.
    await saveAuditBatch(auditRows).catch((err: unknown) => {
      logWarn('agentic_audit_persist_failed', {
        runId,
        count: auditRows.length,
        message: (err as Error).message,
      });
      return 0;
    });

    await saveScreeningResultsBatch(
      outcomes.map((o) => ({
        profileUrl: o.profileUrl,
        verdict: o.decision === 'PASS' ? ('PASS' as const) : ('REJECT' as const),
        reasoning: o.reason,
      })),
      opts.companyName,
      opts.jobName,
    ).catch((err: unknown) => {
      logWarn('agentic_verdict_persist_failed', {
        runId,
        message: (err as Error).message,
      });
      return 0;
    });
  }
}
