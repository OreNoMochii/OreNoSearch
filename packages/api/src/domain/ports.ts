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

/**
 * A candidate row as it arrives from a source, before normalisation.
 *
 * Deliberately open: rows come from the SQL search (folder_id / full_name /
 * ai_latest_* aliases), from a hydration lookup, or straight from the UI, and
 * `normaliseCandidates` reconciles the three shapes.
 */
export type RawCandidateRow = Record<string, unknown>;

/** The search that defines a campaign's candidate set. */
export interface CandidateSearchSpec {
  readonly andGroups: readonly (readonly string[])[];
  readonly must: readonly string[];
  readonly should: readonly string[];
  readonly mustNot: readonly string[];
  readonly locations: readonly string[];
  readonly minExp?: number;
  readonly maxExp?: number;
  readonly excludeCompanies?: readonly string[];
  readonly currentRoleKeywords?: readonly string[];
}

/**
 * How a campaign names its candidate set.
 *
 * `search` and `urls` exist so the rows themselves never travel through the
 * browser and the job queue: a 100,000-candidate campaign is a search
 * description of a few hundred bytes, not several hundred megabytes of resume
 * text posted from a tab and then persisted into Redis.
 */
export type CandidateSpec =
  | { readonly kind: 'search'; readonly params: CandidateSearchSpec }
  | { readonly kind: 'urls'; readonly urls: readonly string[] }
  | { readonly kind: 'inline'; readonly rows: readonly RawCandidateRow[] };

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
  /**
   * Attach company-level intel to each candidate before screening.
   * B30: the flag existed in the request schema and the job payload but never
   * reached a strategy, so the UI's Company Intel toggle did nothing.
   */
  readonly useCompanyIntel?: boolean;
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
 * Resolves a CandidateSpec into actual rows.
 *
 * The Postgres adapter re-runs the search or hydrates by primary key; both are
 * work the database was going to do anyway, done on the same machine as the
 * data instead of after a round trip through a browser tab.
 */
export interface CandidateSource {
  resolve(spec: CandidateSpec, limit: number): Promise<readonly RawCandidateRow[]>;
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
 * Progress sink for a running batch.
 *
 * Infrastructure adapters previously imported `recordBatchProgress` directly
 * from controllers/OutreachController — the infrastructure layer reaching up
 * into the HTTP layer's module state. That inverted the dependency direction
 * and made the adapters unusable outside an Express process.
 */
export interface ProgressReporter {
  report(batchId: number | undefined, delta?: number): void;
  /**
   * Declares how many candidates the batch will process.
   *
   * Only the caller that resolves the candidate set knows this — with a
   * server-side search the enqueuing client cannot, so without this the UI
   * progress bar would have no denominator.
   */
  setTotal(batchId: number | undefined, total: number): void;
}

/** No-op reporter for tests and non-HTTP callers. */
export const nullProgressReporter: ProgressReporter = {
  report: () => undefined,
  setTotal: () => undefined,
};

/**
 * Batch queue.
 *
 * The in-process implementation in OutreachController satisfies this today.
 * A Redis/BullMQ adapter behind the same port is what makes `replicas > 1`
 * safe in docker-compose.prod.yml — see the comment on the api service there.
 */
export interface BatchQueue {
  enqueue(job: unknown): Promise<number>;
  /** `delta` is the number of candidates completed since the last call, not a
   *  running total — the implementation accumulates. */
  reportProgress(batchId: number, delta: number): Promise<void>;
  snapshot(): Promise<{
    readonly activeCount: number;
    readonly pendingCount: number;
    readonly maxConcurrent: number;
  }>;
}
