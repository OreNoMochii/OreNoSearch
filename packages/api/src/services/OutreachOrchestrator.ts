import {
  CandidateSink,
  CandidateSource,
  CandidateSpec,
  OutreachHistoryRepository,
  OutreachNotifier,
  ProgressReporter,
  RawCandidateRow,
  RiskScore,
  RiskScorer,
  ScreenedCandidate,
  ScreeningOptions,
  ScreeningStrategy,
  nullProgressReporter,
} from '../domain/ports';
import { logInfo, logError, logWarn, logSkipped } from '../utils/logger';
import { config } from '../config';

const GENERIC_SUFFIXES =
  /\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|株式会社|k\.k\.?|s\.a\.?|b\.v\.?|plc\.?|pty\.?|group|holdings|japan|international|global)\b/gi;
const BLOCKED_RECIPIENTS = new Set(config.OUTREACH_BLOCKED_RECIPIENTS.map((e) => e.toLowerCase()));

export interface OutreachCommand {
  readonly jdText: string;
  /**
   * How to obtain the candidate set. Resolved here, in the worker, rather than
   * being carried through the browser and the job payload.
   */
  readonly candidateSpec: CandidateSpec;
  readonly companyName: string;
  readonly jobName: string;
  readonly recipients: string;
  readonly cc?: string;
  readonly bypassDeduplication?: boolean;
  readonly batchId?: number;
  /**
   * Attach company-level intel to each candidate before screening.
   * B30: this flag was threaded through the request and the job payload but
   * never reached the orchestrator, so the UI toggle did nothing.
   */
  readonly useCompanyIntel?: boolean;
  readonly screening: {
    // Derived from the port rather than restated, so adding an engine cannot
    // leave this copy of the union behind.
    readonly engine: ScreeningOptions['engine'];
    readonly model: string;
    readonly adjacentRoles?: string;
    readonly topN?: number;
    readonly topK?: number;
    readonly treeTopK?: number;
    readonly minExp?: number;
    readonly maxExp?: number;
  };
}

export class OutreachOrchestrator {
  constructor(
    private readonly strategies: ReadonlyMap<string, ScreeningStrategy>,
    private readonly riskScorer: RiskScorer,
    private readonly sink: CandidateSink,
    private readonly notifier: OutreachNotifier,
    private readonly history: OutreachHistoryRepository,
    private readonly candidateSource: CandidateSource,
    private readonly progress: ProgressReporter = nullProgressReporter,
  ) {}

  private normaliseCandidates(input: readonly RawCandidateRow[]): ScreenedCandidate[] {
    const str = (v: unknown, fallback: string): string =>
      typeof v === 'string' && v.length > 0 ? v : fallback;

    // Optional text: absent is meaningfully different from 'N/A' here, because
    // a screening engine must be able to tell "no data" from a literal string.
    const text = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim().length > 0 ? v : undefined;

    return input.map((c) => ({
      profileUrl: str(c.profile_url ?? c.resume_drive_view_url, 'N/A'),
      name: str(c.name ?? c.full_name, 'Unknown'),
      currentCompany: str(c.current_company ?? c.ai_latest_company, 'N/A'),
      location: str(c.location ?? c.ai_latest_location, 'N/A'),
      headline: str(c.headline ?? c.ai_latest_role, 'N/A'),
      email: str(c.email, 'No Email Found'),
      // The evidence the engines actually reason over. Previously dropped.
      experience: text(c.experience ?? c.resume_text_excerpt),
      summary: text(c.summary ?? c.candidate_summary),
      education: text(c.education),
      skills: text(c.skills),
    }));
  }

  private excludeSameCompany(
    candidates: ScreenedCandidate[],
    companyName: string,
  ): ScreenedCandidate[] {
    const canonical = companyName
      .trim()
      .toLowerCase()
      .replace(GENERIC_SUFFIXES, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (canonical.length < 3) return candidates;

    const tokens = [
      canonical,
      ...canonical.split(/\s+/).filter((t) => t.replace(/[^\w\s]/g, '').trim().length >= 4),
    ];
    const before = candidates.length;
    const kept = candidates.filter((c) => {
      const raw = (c.currentCompany || '').trim().toLowerCase();
      if (!raw || raw === 'n/a') return true;
      const cc = raw.replace(GENERIC_SUFFIXES, '').replace(/\s+/g, ' ').trim();
      if (cc.length < 3) return true;
      const isMatch = tokens.some((t) => cc.includes(t) || t.includes(cc));
      if (isMatch) void logSkipped(c, 'Same-Company Filter', `Currently at "${c.currentCompany}"`);
      return !isMatch;
    });

    logInfo('same_company_filter', { removed: before - kept.length, remaining: kept.length });
    return kept;
  }

  public async run(cmd: OutreachCommand): Promise<void> {
    const strategy = this.strategies.get(cmd.screening.engine);
    if (!strategy) {
      logError(
        'orchestrator_missing_strategy',
        new Error(`No strategy for engine: ${cmd.screening.engine}`),
      );
      return;
    }

    const emailsList = cmd.recipients
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '' && !BLOCKED_RECIPIENTS.has(e.toLowerCase()));

    // Resolve the candidate set here rather than accepting it over HTTP.
    let rows: readonly RawCandidateRow[];
    try {
      rows = await this.candidateSource.resolve(cmd.candidateSpec, config.MAX_CAMPAIGN_CANDIDATES);
    } catch (err) {
      logError('candidate_resolution_failed', err, { batchId: cmd.batchId });
      return;
    }

    let candidates = this.excludeSameCompany(this.normaliseCandidates(rows), cmd.companyName);

    if (candidates.length === 0 && cmd.screening.engine === 'llm') return;

    // Dedup Check
    const urls = candidates.map((c) => c.profileUrl);
    const alreadySent =
      !cmd.bypassDeduplication && emailsList.length > 0
        ? await this.history.findAlreadySent(urls, emailsList, cmd.companyName)
        : new Set<string>();

    candidates = candidates.filter((c) => !alreadySent.has(c.profileUrl));

    // Published after filtering, so the progress denominator is what will
    // actually be screened. The enqueuing client cannot know this figure when
    // the server resolves the candidate set, so without this the UI progress
    // bar would have no denominator at all.
    this.progress.setTotal(cmd.batchId, candidates.length);

    // Screen
    const results = await strategy.screen(cmd.jdText, candidates, {
      ...cmd.screening,
      companyName: cmd.companyName,
      jobName: cmd.jobName,
      batchId: cmd.batchId,
      useCompanyIntel: cmd.useCompanyIntel ?? true,
    });

    const passed = results.filter((r) => r.verdict === 'PASS');
    if (passed.length === 0) {
      logInfo('campaign_complete', { batchId: cmd.batchId, passed: 0 });
      return;
    }

    // Score
    //
    // A dead or misconfigured scoring service used to abort the campaign right
    // here — after the expensive part, the LLM screening run above, had already
    // been paid for and could not be recovered. That is the wrong trade: the
    // flight-risk score is an annotation on the shortlist, not a precondition
    // for it. A failure now degrades to an unscored publish.
    //
    // This is not hypothetical. ML_SCORING_URL defaults to localhost:8000 and
    // the production compose points it at the retrieval service, which has no
    // /score route at all.
    const passedUrls = passed.map((p) => p.profileUrl);
    let riskData: ReadonlyMap<string, RiskScore> = new Map();
    try {
      riskData = await this.riskScorer.score(passedUrls, cmd.jdText);
    } catch (err) {
      logWarn('risk_scoring_unavailable', {
        batchId: cmd.batchId,
        candidates: passedUrls.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Gather candidates that passed for sinking.
    //
    // Indexed once rather than scanned per result: this was
    // `candidates.find(...)` inside a map, so with the tree engine's 2,000
    // passing candidates over a 100,000-row pool it ran up to 2x10^8 string
    // comparisons on the event loop, blocking every other request in the
    // process.
    const byUrl = new Map(candidates.map((c) => [c.profileUrl, c]));
    const passedCandidates = passed.map(
      (p) => byUrl.get(p.profileUrl) ?? { profileUrl: p.profileUrl, name: 'Unknown' },
    );

    // Publish
    const sinkResult = await this.sink.publish({
      batchId: cmd.batchId,
      jobName: cmd.jobName,
      companyName: cmd.companyName,
      candidates: passedCandidates,
      scores: riskData,
      sharedWith: cmd.recipients,
    });

    // Notify
    const subject = `${passedCandidates.length} new candidates added for ${cmd.jobName} at ${cmd.companyName}`;
    const body = sinkResult.url
      ? `${passedCandidates.length} new candidates added.\n\n📊 View spreadsheet: ${sinkResult.url}\n\nScreening model: ${cmd.screening.model}`
      : `Candidates passed screening. Screening model: ${cmd.screening.model}`;

    const notified = await this.notifier.notify({
      subject,
      body,
      to: cmd.recipients,
      cc: cmd.cc,
    });

    if (notified && emailsList.length > 0) {
      await this.history.markSent(passedUrls, emailsList, cmd.companyName, cmd.jobName);
      logInfo('outreach_history_written', { batchId: cmd.batchId, marked: passedUrls.length });
    } else if (!notified) {
      logWarn('email_failed_history_skipped', {
        batchId: cmd.batchId,
        candidates: passedUrls.length,
      });
    }

    logInfo('campaign_complete', {
      batchId: cmd.batchId,
      passed: passedUrls.length,
      emailSent: notified,
    });
  }
}
