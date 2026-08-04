import {
  CandidateSink,
  OutreachHistoryRepository,
  OutreachNotifier,
  RiskScorer,
  ScreenedCandidate,
  ScreeningStrategy,
} from '../domain/ports';
import { logInfo, logError, logWarn, logSkipped } from '../utils/logger';
import { config } from '../config';

const GENERIC_SUFFIXES =
  /\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|株式会社|k\.k\.?|s\.a\.?|b\.v\.?|plc\.?|pty\.?|group|holdings|japan|international|global)\b/gi;
const BLOCKED_RECIPIENTS = new Set(config.OUTREACH_BLOCKED_RECIPIENTS.map((e) => e.toLowerCase()));

export interface OutreachCommand {
  readonly jdText: string;
  readonly uiCandidates: readonly any[];
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
    readonly engine: 'llm' | 'tree' | 'tree_llm' | 'pipeline';
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
  ) {}

  private normaliseCandidates(input: readonly any[]): ScreenedCandidate[] {
    return input.map((c) => ({
      profileUrl: c.profile_url ?? c.resume_drive_view_url ?? 'N/A',
      name: c.name ?? c.full_name ?? 'Unknown',
      currentCompany: c.current_company ?? c.ai_latest_company ?? 'N/A',
      location: c.location ?? c.ai_latest_location ?? 'N/A',
      headline: c.headline ?? c.ai_latest_role ?? 'N/A',
      email: c.email ?? 'No Email Found',
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

    let candidates = this.excludeSameCompany(
      this.normaliseCandidates(cmd.uiCandidates),
      cmd.companyName,
    );

    if (candidates.length === 0 && cmd.screening.engine === 'llm') return;

    // Dedup Check
    const urls = candidates.map((c) => c.profileUrl);
    const alreadySent =
      !cmd.bypassDeduplication && emailsList.length > 0
        ? await this.history.findAlreadySent(urls, emailsList, cmd.companyName)
        : new Set<string>();

    candidates = candidates.filter((c) => !alreadySent.has(c.profileUrl));

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
    const passedUrls = passed.map((p) => p.profileUrl);
    const riskData = await this.riskScorer.score(passedUrls, cmd.jdText);

    // Gather candidates that passed for sinking
    // If pipeline, we might have full candidate data in result._fullCandidateData
    const passedCandidates = passed.map((p) => {
      const original = candidates.find((c) => c.profileUrl === p.profileUrl);
      return original ?? { profileUrl: p.profileUrl, name: 'Unknown' };
    });

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
