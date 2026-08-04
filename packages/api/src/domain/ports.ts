/**
 * domain/ports.ts — the interfaces the outreach orchestrator depends on.
 *
 * OutreachService currently talks to concrete module-level singletons
 * (emailService, googleSheetsService, screeningAgent, …) that construct
 * themselves at import time. That makes the orchestration logic impossible to
 * exercise without a live Gmail token, a Drive folder and an LLM provider.
 *
 * These ports invert that dependency: the orchestrator states what it needs,
 * and infrastructure adapters supply it. Defining them here is the first step —
 * the concrete services already satisfy most of these shapes structurally, so
 * migration is incremental rather than a rewrite.
 *
 * STATUS: interfaces only. OutreachService has not yet been switched to
 * constructor injection; see the follow-up note in the README.
 */

// ── Value types ─────────────────────────────────────────────────────────────

export interface ScreenedCandidate {
    readonly profileUrl: string;
    readonly name: string;
    readonly currentCompany?: string;
    readonly location?: string;
    readonly headline?: string;
    readonly email?: string;
}

export interface RiskScore {
    /** Cox proportional-hazards score. Higher means likelier to move. */
    readonly hazard: number;
    /** Learning-to-rank relevance against the job description. */
    readonly relevancy: number;
    /** Probability of changing employer within the horizon, 0–1. */
    readonly moveProb: number;
    /** Tenure in the current role, months. */
    readonly tenureMonths: number;
    readonly medianTenure?: number;
}

export type Verdict = 'PASS' | 'REJECT';

export interface ScreeningResult {
    readonly profileUrl: string;
    readonly verdict: Verdict;
    readonly reasoning: string;
    /** True when the provider rate-limited us; drives adaptive concurrency. */
    readonly rateLimited?: boolean;
}

export interface ScreeningOptions {
    readonly engine: 'llm' | 'tree' | 'tree_llm' | 'pipeline';
    readonly model: string;
    readonly adjacentRoles?: string;
    readonly topN?: number;
    readonly topK?: number;
    readonly treeTopK?: number;
    readonly minExp?: number;
    readonly maxExp?: number;
    readonly companyName: string;
    readonly jobName: string;
    readonly batchId?: number;
}

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * A candidate-screening strategy.
 *
 * Each engine (LLM audit, tree scorer, hybrid, retrieval pipeline) becomes its
 * own implementation, replacing the `if (screeningEngine === 'tree' || …)`
 * branching that currently spans several hundred lines of OutreachService.
 */
export interface ScreeningStrategy {
    readonly name: ScreeningOptions['engine'];
    screen(
        jd: string,
        candidates: readonly ScreenedCandidate[],
        opts: ScreeningOptions,
    ): Promise<readonly ScreeningResult[]>;
}

/**
 * Attrition and match scoring.
 *
 * Two adapters exist in practice: an HTTP client against the FastAPI scoring
 * service, and a subprocess runner over inference.py. Both satisfy this port,
 * so the orchestrator does not care which is in play.
 */
export interface RiskScorer {
    score(profileUrls: readonly string[], jdText: string): Promise<ReadonlyMap<string, RiskScore>>;
}

/** Where a shortlist is published for humans to act on (currently Sheets). */
export interface CandidateSink {
    publish(batch: {
        readonly batchId?: number;
        readonly jobName: string;
        readonly companyName: string;
        readonly candidates: readonly ScreenedCandidate[];
        readonly scores: ReadonlyMap<string, RiskScore>;
        readonly sharedWith: string;
    }): Promise<{ readonly url: string; readonly inserted: number }>;
}

/** Outbound notification. Returns false rather than throwing on failure, so a
 *  delivery error cannot mark a batch as contacted. */
export interface OutreachNotifier {
    notify(message: {
        readonly subject: string;
        readonly body: string;
        readonly to: string;
        readonly cc?: string;
    }): Promise<boolean>;
}

/** Deduplication and audit history. */
export interface OutreachHistoryRepository {
    findAlreadySent(
        profileUrls: readonly string[],
        recipients: readonly string[],
        companyName: string,
    ): Promise<ReadonlySet<string>>;

    markSent(
        profileUrls: readonly string[],
        recipients: readonly string[],
        companyName: string,
        jobName: string,
    ): Promise<number>;
}

/**
 * Batch queue.
 *
 * The in-process implementation in OutreachController satisfies this today.
 * A Redis/BullMQ adapter behind the same port is what makes `replicas > 1`
 * safe in docker-compose.prod.yml — see the comment on the api service there.
 */
export interface BatchQueue {
    enqueue(job: unknown): Promise<number>;
    reportProgress(batchId: number, processed: number): Promise<void>;
    snapshot(): Promise<{
        readonly activeCount: number;
        readonly pendingCount: number;
        readonly maxConcurrent: number;
    }>;
}
