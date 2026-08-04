import { logInfo, logWarn, logError, logDebug, logSkipped } from '../utils/logger';
import { config } from '../config';
import { runPython } from '../utils/python_runner';
import { emailService } from './EmailService';
import { screeningAgent } from './ScreeningAgent';
import { retrievalPipelineService } from './RetrievalPipelineService';
import { googleSheetsService } from './GoogleSheetsService';
import { ScoringResponse, type CandidateInput, type RiskScoreEntry } from '../core/schemas';
import {
    getSentCandidatesBatch,
    logOutreachSent,
    saveScreeningResult,
    getScreenedCandidatesBatch,
    getCompanyIntelBatch,
} from '../repositories/postgres_repo';
import { recordBatchProgress } from '../controllers/OutreachController';
import { createObjectCsvWriter } from 'csv-writer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

const OUTPUT_CSV = path.join(process.cwd(), 'generated_outreach_emails.csv');

/**
 * Recipients excluded from outreach-history logging. Sourced from the
 * environment so no personal address is hard-coded into the repository.
 */
const BLOCKED_RECIPIENTS = new Set(config.OUTREACH_BLOCKED_RECIPIENTS.map((e) => e.toLowerCase()));

const PY_INFERENCE = path.resolve(__dirname, '../../../machine_learning/src/inference.py');
const PY_TREE_SCORER = path.resolve(
    __dirname,
    '../../../machine_learning/tree_scorer/jd_tree_scorer.py',
);

type RiskMap = Record<string, RiskScoreEntry>;

export interface OutreachCampaignOptions {
    jdText: string;
    uiCandidates: CandidateInput[];
    companyName: string;
    jobName: string;
    /** Comma-separated recipient list, already validated by the request schema. */
    recipients: string;
    targetModel?: string;
    adjacentRoles?: string;
    bypassDeduplication?: boolean;
    batchId?: number;
    cc?: string;
    usePipeline?: boolean;
    topN?: number;
    topK?: number;
    minExp?: number;
    maxExp?: number;
    screeningEngine?: 'llm' | 'tree' | 'tree_llm';
    treeTopK?: number;
    useCompanyIntel?: boolean;
}

interface NormalisedCandidate extends Record<string, unknown> {
    name: string;
    profile_url: string;
    current_company: string;
    location: string;
    summary: string;
    experience: string;
    education: string;
    headline: string;
    skills: string;
    _treeScore?: number;
    _langScore?: number;
    _companyIntel?: string;
}

/** Company-name suffixes stripped before comparing employers. */
const GENERIC_SUFFIXES =
    /\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|株式会社|k\.k\.?|s\.a\.?|b\.v\.?|plc\.?|pty\.?|group|holdings|japan|international|global)\b/gi;

export class OutreachService {
    /**
     * Appends passed candidates to the CSV in one write.
     *
     * B16: this previously constructed a fresh csvWriter per candidate and used
     * `append: fs.existsSync(...)` to decide whether to emit a header. Called
     * concurrently from a screening wave, that races — several writers can all
     * observe "file absent" and each emit a header row. Batching the write
     * removes both the race and the per-candidate blocking append.
     */
    private async savePassedCandidateLogs(
        candidates: ReadonlyArray<{ name?: string; email?: string; profile_url?: string }>,
    ): Promise<void> {
        if (candidates.length === 0) return;

        try {
            const csvWriter = createObjectCsvWriter({
                path: OUTPUT_CSV,
                header: [
                    { id: 'name', title: 'Candidate_Name' },
                    { id: 'email', title: 'Candidate_Email' },
                    { id: 'url', title: 'Profile_URL' },
                ],
                append: fs.existsSync(OUTPUT_CSV),
            });
            await csvWriter.writeRecords(
                candidates.map((c) => ({
                    name: c.name ?? 'Unknown',
                    email: c.email ?? 'No Email Found',
                    url: c.profile_url ?? 'N/A',
                })),
            );
        } catch (err) {
            logError('csv_write_failed', err, { count: candidates.length });
        }
    }

    /** Calls the ML scoring service; falls back to the local script if unreachable. */
    private async scoreCandidates(profileUrls: string[], jdText: string): Promise<RiskMap> {
        if (profileUrls.length === 0) return {};

        // Preferred path: the long-running FastAPI service, which keeps the
        // LightGBM/PyTorch models resident instead of reloading them per batch.
        try {
            const resp = await fetch(`${config.ML_SCORING_URL}/score`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile_urls: profileUrls, jd_text: jdText }),
                signal: AbortSignal.timeout(config.RETRIEVAL_TIMEOUT_MS),
            });
            if (!resp.ok) throw new Error(`Scoring service returned ${resp.status}`);
            const parsed = ScoringResponse.safeParse(await resp.json());
            if (!parsed.success) throw new Error('Malformed scoring response');
            logInfo('scoring_via_service', {
                count: Object.keys(parsed.data.scored_candidates).length,
            });
            return parsed.data.scored_candidates;
        } catch (err) {
            logWarn('scoring_service_unavailable', { message: (err as Error).message });
        }

        // Fallback: run inference.py directly. B1 — no shell involved.
        try {
            const raw = await runPython<RiskMap>({
                scriptPath: PY_INFERENCE,
                stdinPayload: profileUrls,
            });
            logInfo('scoring_via_subprocess', { count: Object.keys(raw).length });
            return raw;
        } catch (err) {
            logError('scoring_failed', err, { count: profileUrls.length });
            return {};
        }
    }

    private normaliseCandidates(input: CandidateInput[]): NormalisedCandidate[] {
        return input.map((c) => ({
            ...c,
            name: c.name ?? c.full_name ?? 'Unknown',
            profile_url: c.profile_url ?? c.resume_drive_view_url ?? 'N/A',
            current_company: c.current_company ?? c.ai_latest_company ?? 'N/A',
            location: c.location ?? c.ai_latest_location ?? 'N/A',
            summary: c.summary ?? c.candidate_summary ?? 'N/A',
            experience: c.experience ?? c.resume_text_excerpt ?? 'N/A',
            education: c.education ?? 'N/A',
            headline: c.headline ?? c.ai_latest_role ?? 'N/A',
            skills: c.skills ?? 'N/A',
        }));
    }

    /** Removes candidates already employed by the hiring company. */
    private excludeSameCompany(
        candidates: NormalisedCandidate[],
        companyName: string,
    ): NormalisedCandidate[] {
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
            const raw = (c.current_company || '').trim().toLowerCase();
            if (!raw || raw === 'n/a') return true;
            const cc = raw.replace(GENERIC_SUFFIXES, '').replace(/\s+/g, ' ').trim();
            if (cc.length < 3) return true;
            const isMatch = tokens.some((t) => cc.includes(t) || t.includes(cc));
            if (isMatch) {
                void logSkipped(c, 'Same-Company Filter', `Currently at "${c.current_company}"`);
            }
            return !isMatch;
        });

        logInfo('same_company_filter', { removed: before - kept.length, remaining: kept.length });
        return kept;
    }

    /** Ranks by relevancy, then hazard, then tenure — all descending. */
    private rank(urls: string[], risk: RiskMap): string[] {
        const zero: RiskScoreEntry = { hazard: 0, relevancy: 0, move_prob: 0, tenure: 0 };
        return [...urls]
            .filter((u) => {
                const d = risk[u];
                return d ? d.move_prob >= 0.02 : true;
            })
            .sort((a, b) => {
                const x = risk[a] ?? zero;
                const y = risk[b] ?? zero;
                if (y.relevancy !== x.relevancy) return y.relevancy - x.relevancy;
                if (y.move_prob !== x.move_prob) return y.move_prob - x.move_prob;
                if (y.hazard !== x.hazard) return y.hazard - x.hazard;
                return y.tenure - x.tenure;
            });
    }

    private formatCandidateLine(url: string, risk: RiskMap, extra = ''): string {
        const d = risk[url];
        if (!d) return `${url} (Risk: N/A${extra})`;
        const badge = d.move_prob >= 0.15 ? '[RESTLESS]' : '[STABLE]';
        return (
            `${badge.padEnd(12)} | Hazard: ${d.hazard.toFixed(2)} | ` +
            `Move Prob: ${(d.move_prob * 100).toFixed(2)}% | ` +
            `Tenure: ${d.tenure.toFixed(1)}mo${extra} | URL: ${url}`
        );
    }

    public async runOutreachCampaign(opts: OutreachCampaignOptions): Promise<void> {
        const {
            jdText,
            uiCandidates,
            companyName,
            jobName,
            recipients,
            targetModel = 'deepseek-ai/DeepSeek-V3.2',
            adjacentRoles = '',
            bypassDeduplication = false,
            batchId,
            cc,
            usePipeline = false,
            topN = 700,
            topK = 300,
            minExp,
            maxExp,
            screeningEngine = 'llm',
            treeTopK = 1000,
            useCompanyIntel = true,
        } = opts;

        const emailsList = recipients
            .split(',')
            .map((e) => e.trim())
            .filter((e) => e !== '' && !BLOCKED_RECIPIENTS.has(e.toLowerCase()));

        if (!usePipeline && screeningEngine === 'llm' && uiCandidates.length === 0) return;

        // ── Advanced pipeline path ──────────────────────────────────────────
        if (usePipeline) {
            const handled = await this.runPipelinePath({
                jdText,
                companyName,
                jobName,
                recipients,
                cc,
                targetModel,
                topN,
                topK,
                minExp,
                maxExp,
                batchId,
                emailsList,
            });
            if (handled) return;
        }

        // ── Standard path ───────────────────────────────────────────────────
        let candidates = this.excludeSameCompany(
            this.normaliseCandidates(uiCandidates),
            companyName,
        );

        if (candidates.length === 0 && screeningEngine === 'llm') return;

        let spreadsheetId = '';
        let existingSheetUrls = new Set<string>();
        try {
            spreadsheetId = await googleSheetsService.findOrCreateSpreadsheet(jobName, companyName);
            existingSheetUrls = await googleSheetsService.loadExistingUrls(spreadsheetId);
        } catch (err) {
            logError('gsheets_init_failed', err);
        }

        const passedCandidateUrls: string[] = [];
        const passedForCsv: NormalisedCandidate[] = [];
        let candidatesToAudit = candidates;

        const allProfileUrls = candidates.map((c) => c.profile_url).filter((u) => u !== 'N/A');
        const screenedSet = await getScreenedCandidatesBatch(allProfileUrls, companyName, jobName);

        if (useCompanyIntel) {
            const names = candidates
                .map((c) => c.current_company)
                .filter((n): n is string => !!n && n.trim().length > 0);
            const intel = await getCompanyIntelBatch(names);
            logInfo('company_intel_loaded', { matched: intel.size });
            for (const c of candidates) {
                const hit = intel.get((c.current_company ?? '').trim().toLowerCase());
                if (hit) {
                    c._companyIntel =
                        `[Company Intel] ${hit.company_type} | Size: ${hit.size_band} | ` +
                        `Flight Risk: ${hit.flight_risk} | Compensation: ${hit.compensation}`;
                }
            }
        }

        // ── Tree scorer ─────────────────────────────────────────────────────
        if (screeningEngine === 'tree' || screeningEngine === 'tree_llm') {
            const result = await this.runTreeScorer({
                jdText,
                companyName,
                jobName,
                candidates,
                treeTopK,
                screenedSet,
                screeningEngine,
                spreadsheetId,
                existingSheetUrls,
                recipients,
                passedCandidateUrls,
                passedForCsv,
                batchId,
            });
            candidates = result.candidates;
            if (screeningEngine === 'tree_llm') candidatesToAudit = result.passedTree;
            else candidatesToAudit = [];
        }

        // ── LLM audit ───────────────────────────────────────────────────────
        if (
            (screeningEngine === 'llm' || screeningEngine === 'tree_llm') &&
            candidatesToAudit.length > 0
        ) {
            await this.runLlmAudit({
                jdText,
                companyName,
                jobName,
                targetModel,
                adjacentRoles,
                candidatesToAudit,
                screenedSet,
                bypassDeduplication,
                emailsList,
                spreadsheetId,
                existingSheetUrls,
                recipients,
                batchId,
                passedCandidateUrls,
                passedForCsv,
            });
        }

        await this.savePassedCandidateLogs(passedForCsv);

        if (passedCandidateUrls.length === 0) {
            logInfo('campaign_complete', { batchId, passed: 0, processed: candidates.length });
            return;
        }

        // ── Scoring, notification, history ──────────────────────────────────
        const riskData = await this.scoreCandidates(passedCandidateUrls, jdText);
        const rankedUrls = this.rank(passedCandidateUrls, riskData);

        if (spreadsheetId && Object.keys(riskData).length > 0) {
            await googleSheetsService.backfillRiskScores(spreadsheetId, riskData);
        }

        const sheetUrl = spreadsheetId ? googleSheetsService.getSpreadsheetUrl(spreadsheetId) : '';
        const subject = `${rankedUrls.length} new candidates added for ${jobName} at ${companyName}`;
        const body = sheetUrl
            ? [
                  `${rankedUrls.length} new candidates have been added to the spreadsheet.`,
                  ``,
                  `📊 View spreadsheet: ${sheetUrl}`,
                  ``,
                  `---`,
                  `Screening model: ${targetModel}`,
              ].join('\n')
            : [
                  `Candidates that passed all verification steps:`,
                  ``,
                  rankedUrls
                      .map((url) => {
                          const c = candidates.find((x) => x.profile_url === url);
                          const extra =
                              c?._treeScore !== undefined
                                  ? ` | Tree: ${c._treeScore.toFixed(2)} | Lang: ${c._langScore}/3`
                                  : '';
                          return this.formatCandidateLine(url, riskData, extra);
                      })
                      .join('\n'),
                  ``,
                  `---`,
                  `Screening model: ${targetModel}`,
              ].join('\n');

        const emailSent = await emailService.sendEmail(subject, body, recipients, cc);

        if (emailSent) {
            // B12: mark exactly the candidates that were actually surfaced.
            // The previous code iterated the *unfiltered* list, so candidates
            // dropped for low move_prob were recorded as contacted and were
            // permanently suppressed by the dedup check without ever appearing
            // in an email.
            if (emailsList.length > 0) {
                const marked = await logOutreachSent(rankedUrls, emailsList, companyName, jobName);
                logInfo('outreach_history_written', { batchId, marked });
            }
        } else {
            logWarn('email_failed_history_skipped', { batchId, candidates: rankedUrls.length });
        }

        logInfo('campaign_complete', {
            batchId,
            passed: passedCandidateUrls.length,
            surfaced: rankedUrls.length,
            emailSent,
        });
    }

    // ── Pipeline path ────────────────────────────────────────────────────────
    private async runPipelinePath(a: {
        jdText: string;
        companyName: string;
        jobName: string;
        recipients: string;
        cc?: string;
        targetModel: string;
        topN: number;
        topK: number;
        minExp?: number;
        maxExp?: number;
        batchId?: number;
        emailsList: string[];
    }): Promise<boolean> {
        if (!(await retrievalPipelineService.isHealthy())) {
            logWarn('pipeline_unhealthy_falling_back');
            return false;
        }

        const result = await retrievalPipelineService.search(
            a.jdText,
            a.topN,
            a.topK,
            a.companyName,
            a.targetModel,
            a.minExp,
            a.maxExp,
        );
        if (!result || result.candidates.length === 0) {
            logWarn('pipeline_returned_nothing_falling_back');
            return false;
        }

        const urls = result.candidates.map((c) => c.profile_url);
        recordBatchProgress(a.batchId, result.meta.total_retrieved);
        await this.savePassedCandidateLogs(result.candidates);

        const riskData = await this.scoreCandidates(urls, a.jdText);
        const rankedUrls = this.rank(urls, riskData);

        const sheetCandidates = rankedUrls.map((url) => {
            const c = result.candidates.find((x) => x.profile_url === url);
            return {
                name: c?.name ?? 'Unknown',
                profile_url: url,
                headline: c?.headline ?? '',
                current_company: c?.current_company ?? '',
                location: c?.location ?? '',
            };
        });

        let sheetUrl = '';
        let newCount = sheetCandidates.length;
        try {
            const id = await googleSheetsService.findOrCreateSpreadsheet(a.jobName, a.companyName);
            newCount = await googleSheetsService.appendCandidates(
                id,
                sheetCandidates,
                riskData,
                a.recipients,
            );
            sheetUrl = googleSheetsService.getSpreadsheetUrl(id);
        } catch (err) {
            logError('gsheets_pipeline_failed', err);
        }

        const m = result.meta;
        const stats =
            `Pipeline stats: Retrieved ${m.total_retrieved} → Reranked to ${m.after_rerank} → ` +
            `${m.passed_audit} passed audit (${m.duration_seconds}s)`;
        const subject = `[🚀 Pipeline] ${newCount} new candidates for ${a.jobName} at ${a.companyName}`;
        const body = sheetUrl
            ? [
                  `${newCount} new candidates added.`,
                  ``,
                  `📊 ${sheetUrl}`,
                  ``,
                  stats,
                  `Screening model: ${a.targetModel}`,
              ].join('\n')
            : [
                  stats,
                  ``,
                  `Candidates that passed screening:`,
                  ``,
                  rankedUrls
                      .map((u) => {
                          const c = result.candidates.find((x) => x.profile_url === u);
                          const fit = c?.audit_fit_score ? ` | Fit: ${c.audit_fit_score}/5` : '';
                          return this.formatCandidateLine(u, riskData, fit);
                      })
                      .join('\n'),
                  ``,
                  `---`,
                  `Screening model: ${a.targetModel}`,
              ].join('\n');

        const sent = await emailService.sendEmail(subject, body, a.recipients, a.cc);
        if (sent && a.emailsList.length > 0) {
            const marked = await logOutreachSent(
                rankedUrls,
                a.emailsList,
                a.companyName,
                a.jobName,
            );
            logInfo('outreach_history_written', { batchId: a.batchId, marked });
        } else if (!sent) {
            logWarn('email_failed_history_skipped', { batchId: a.batchId });
        }

        logInfo('pipeline_campaign_complete', { batchId: a.batchId, passed: urls.length });
        return true;
    }

    // ── Tree scorer path ─────────────────────────────────────────────────────
    private async runTreeScorer(a: {
        jdText: string;
        companyName: string;
        jobName: string;
        candidates: NormalisedCandidate[];
        treeTopK: number;
        screenedSet: Map<string, 'PASS' | 'REJECT'>;
        screeningEngine: string;
        spreadsheetId: string;
        existingSheetUrls: Set<string>;
        recipients: string;
        passedCandidateUrls: string[];
        passedForCsv: NormalisedCandidate[];
        batchId?: number;
    }): Promise<{ candidates: NormalisedCandidate[]; passedTree: NormalisedCandidate[] }> {
        let candidates = a.candidates;
        const passedTree: NormalisedCandidate[] = [];

        logInfo('tree_scorer_started', { count: candidates.length || 'ALL' });

        try {
            // B1: argv array + stdin, no shell, no temp file on disk.
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
                    jd: a.jdText,
                    companyName: a.companyName,
                    candidates,
                    topK: a.treeTopK,
                },
            });

            if (parsed.error) {
                logError('tree_scorer_error', new Error(parsed.error));
                return { candidates, passedTree };
            }

            const results = parsed.candidates ?? [];

            // Pure-ML path: the scorer sourced candidates itself.
            if (candidates.length === 0) {
                candidates = results.map((r) => ({
                    ...r,
                    name: r.name,
                    profile_url: r.profile_url,
                    current_company: r.current_company ?? 'N/A',
                    location: 'N/A',
                    summary: 'N/A',
                    experience: 'N/A',
                    education: 'N/A',
                    headline: 'N/A',
                    skills: 'N/A',
                    _treeScore: r.tree_score,
                    _langScore: r.lang_infer_score,
                }));
            }

            for (const r of results) {
                const candObj = candidates.find((c) => c.profile_url === r.profile_url);

                if (a.screeningEngine === 'tree' && a.screenedSet.has(r.profile_url)) {
                    if (a.screenedSet.get(r.profile_url) === 'PASS') {
                        a.passedCandidateUrls.push(r.profile_url);
                    }
                    continue;
                }

                if (r.tree_score >= 0.5) {
                    await saveScreeningResult(
                        r.profile_url,
                        a.companyName,
                        a.jobName,
                        'PASS',
                        `Tree Score: ${r.tree_score.toFixed(3)}`,
                    );
                    if (a.screeningEngine === 'tree') {
                        a.passedCandidateUrls.push(r.profile_url);
                        if (candObj) {
                            a.passedForCsv.push(candObj);
                            if (a.spreadsheetId) {
                                await googleSheetsService.appendSingleCandidate(
                                    a.spreadsheetId,
                                    candObj,
                                    a.existingSheetUrls,
                                    a.recipients,
                                );
                            }
                        }
                    }
                    if (candObj) {
                        candObj._treeScore = r.tree_score;
                        candObj._langScore = r.lang_infer_score;
                        passedTree.push(candObj);
                    }
                } else {
                    await saveScreeningResult(
                        r.profile_url,
                        a.companyName,
                        a.jobName,
                        'REJECT',
                        `Tree Score: ${r.tree_score.toFixed(3)}`,
                    );
                }
            }

            logInfo('tree_scorer_complete', { scored: results.length, passed: passedTree.length });
        } catch (err) {
            logError('tree_scorer_failed', err);
        } finally {
            recordBatchProgress(a.batchId, candidates.length);
        }

        return { candidates, passedTree };
    }

    // ── LLM audit path ───────────────────────────────────────────────────────
    private async runLlmAudit(a: {
        jdText: string;
        companyName: string;
        jobName: string;
        targetModel: string;
        adjacentRoles: string;
        candidatesToAudit: NormalisedCandidate[];
        screenedSet: Map<string, 'PASS' | 'REJECT'>;
        bypassDeduplication: boolean;
        emailsList: string[];
        spreadsheetId: string;
        existingSheetUrls: Set<string>;
        recipients: string;
        batchId?: number;
        passedCandidateUrls: string[];
        passedForCsv: NormalisedCandidate[];
    }): Promise<void> {
        const isNvidia = a.targetModel.startsWith('nvidia:');
        const MAX_CONCURRENCY = isNvidia ? 4 : 10;
        const MIN_CONCURRENCY = 1;
        const RAMP_UP_THRESHOLD = 15;
        let currentConcurrency = isNvidia ? 2 : 5;

        const total = a.candidatesToAudit.length;
        logInfo('llm_audit_started', {
            total,
            model: a.targetModel,
            concurrency: currentConcurrency,
        });

        const profileUrls = a.candidatesToAudit
            .map((c) => c.profile_url)
            .filter((u) => u !== 'N/A');
        const alreadySent =
            !a.bypassDeduplication && a.emailsList.length > 0
                ? await getSentCandidatesBatch(profileUrls, a.emailsList, a.companyName)
                : new Set<string>();

        let processed = 0;
        let consecutiveSuccesses = 0;
        let rateLimitHits = 0;

        while (processed < total) {
            const waveSize = Math.min(currentConcurrency, total - processed);
            const wave = a.candidatesToAudit.slice(processed, processed + waveSize);

            const results = await Promise.allSettled(
                wave.map(async (candidate) => {
                    const url = candidate.profile_url;
                    try {
                        if (!a.bypassDeduplication && url !== 'N/A') {
                            if (alreadySent.has(url)) return { status: 'skipped' as const };
                            const prior = a.screenedSet.get(url);
                            if (prior) {
                                if (prior === 'PASS') a.passedCandidateUrls.push(url);
                                return { status: 'skipped' as const };
                            }
                        }

                        const { isMatch, reasoning, rateLimited } =
                            await screeningAgent.verificationAgent(
                                a.jdText,
                                candidate,
                                a.targetModel,
                                a.adjacentRoles,
                            );

                        if (rateLimited) return { status: 'rate_limited' as const };

                        if (isMatch) {
                            a.passedCandidateUrls.push(url);
                            a.passedForCsv.push(candidate);
                            await saveScreeningResult(
                                url,
                                a.companyName,
                                a.jobName,
                                'PASS',
                                reasoning,
                            );
                            if (a.spreadsheetId) {
                                await googleSheetsService.appendSingleCandidate(
                                    a.spreadsheetId,
                                    candidate,
                                    a.existingSheetUrls,
                                    a.recipients,
                                );
                            }
                        } else {
                            await saveScreeningResult(
                                url,
                                a.companyName,
                                a.jobName,
                                'REJECT',
                                reasoning,
                            );
                            void logSkipped(candidate, 'Verification Agent', reasoning);
                        }
                        return { status: 'success' as const };
                    } catch (err) {
                        logError('candidate_screening_failed', err, { name: candidate.name });
                        return { status: 'error' as const };
                    } finally {
                        recordBatchProgress(a.batchId);
                    }
                }),
            );

            const waveRateLimited = results.some(
                (r) => r.status === 'fulfilled' && r.value.status === 'rate_limited',
            );

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
                if (
                    consecutiveSuccesses >= RAMP_UP_THRESHOLD &&
                    currentConcurrency < MAX_CONCURRENCY
                ) {
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
            passed: a.passedCandidateUrls.length,
            rateLimitHits,
            finalConcurrency: currentConcurrency,
        });
    }
}

export const outreachService = new OutreachService();
