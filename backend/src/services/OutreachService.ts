import { logDebug, logSkipped } from '../utils/logger';
import { emailService } from './EmailService';
import { screeningAgent } from './ScreeningAgent';
import { retrievalPipelineService } from './RetrievalPipelineService';
import { googleSheetsService } from './GoogleSheetsService';
import { createObjectCsvWriter } from 'csv-writer';
import { getSentCandidatesBatch, logOutreachSent, saveScreeningResult, getScreenedCandidatesBatch, getCompanyIntelBatch } from '../repositories/postgres_repo';
import { activeBatchDetails } from '../controllers/OutreachController';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const OUTPUT_CSV = path.join(process.cwd(), 'generated_outreach_emails.csv');
const OUTPUT_LOG = path.join(process.cwd(), 'generated_outreach_emails.txt');

// Recipients excluded from outreach-history logging. Sourced from the
// environment so no personal address is hard-coded into the repository.
// Set OUTREACH_BLOCKED_RECIPIENTS in .env as a comma-separated list.
const BLOCKED_RECIPIENTS = new Set(
    (process.env.OUTREACH_BLOCKED_RECIPIENTS ?? '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)
);

export class OutreachService {
    
    private async savePassedCandidateLogs(candidate: any, profileUrl: string) {
        const csvWriter = createObjectCsvWriter({
            path: OUTPUT_CSV,
            header: [
                { id: 'name', title: 'Candidate_Name' },
                { id: 'email', title: 'Candidate_Email' },
                { id: 'url', title: 'Profile_URL' }
            ],
            append: fs.existsSync(OUTPUT_CSV)
        });

        const name = candidate.name || 'Unknown';

        await csvWriter.writeRecords([{
            name: name,
            email: candidate.email || 'No Email Found',
            url: profileUrl
        }]);

        const logEntry = `--- PASSED CANDIDATE: ${name} ---\n` +
            `Email: ${candidate.email || 'No Email Found'}\n` +
            `URL: ${profileUrl}\n` +
            `${"=".repeat(60)}\n\n`;
        fs.appendFileSync(OUTPUT_LOG, logEntry);
    }

    public async runOutreachCampaign(
        jdText: string,
        uiCandidates: any[],
        companyName: string,
        testTo: string,
        targetModel: string = "deepseek-ai/DeepSeek-V3.2",
        adjacentRoles: string = "",
        jobName: string = "",
        bypassDeduplication: boolean = false,
        batchId?: number,
        testCc?: string,
        usePipeline: boolean = false,
        topN: number = 700,
        topK: number = 300,
        minExp?: number,
        maxExp?: number,
        screeningEngine: string = "llm",
        treeTopK: number = 1000,
        useCompanyIntel: boolean = true
    ) {
        // If not using pipeline or tree engine, we MUST have boolean candidates. If using pipeline or tree, we don't need them.
        if (!usePipeline && screeningEngine !== 'tree' && (!uiCandidates || uiCandidates.length === 0)) return;

        const emailsList = testTo.split(',')
            .map(e => e.trim())
            .filter(e => e !== '' && !BLOCKED_RECIPIENTS.has(e.toLowerCase()));

        // ── Advanced Pipeline Path ───────────────────────────────────────────
        if (usePipeline) {
            const healthy = await retrievalPipelineService.isHealthy();
            if (!healthy) {
                await logDebug('[Pipeline] ⚠️  Retrieval microservice is not running — falling back to standard screening path.');
                await logDebug('[Pipeline]    Start it with: npm run retrieval-service');
            } else {
                await logDebug(`[Pipeline] 🚀 Advanced pipeline active (top_n=${topN}, top_k=${topK})`);

                const pipelineResult = await retrievalPipelineService.search(
                    jdText, topN, topK, companyName, targetModel, minExp, maxExp
                );

                if (!pipelineResult || pipelineResult.candidates.length === 0) {
                    await logDebug('[Pipeline] No candidates returned from pipeline — falling back to standard path.');
                } else {
                    const passedCandidateUrls = pipelineResult.candidates.map(c => c.profile_url);

                    // Log passed candidates (same format as standard path)
                    for (const c of pipelineResult.candidates) {
                        await logDebug(`  [Pipeline] ✅ PASS: ${c.name} (fit=${c.audit_fit_score}/5, rerank=${c.reranker_score?.toFixed(3)})`);
                        await this.savePassedCandidateLogs(c, c.profile_url);
                    }

                    // Update batch progress counter
                    if (batchId) {
                        const detail = activeBatchDetails.get(batchId);
                        if (detail) {
                            detail.processed = pipelineResult.meta.total_retrieved;
                            activeBatchDetails.set(batchId, detail);
                        }
                    }

                    // ── ML Scoring API Integration ─────────
                    let riskData: Record<string, { hazard: number, relevancy: number, move_prob: number, tenure: number, median_tenure?: number }> = {};
                    try {
                        await logDebug(`\nScoring ${passedCandidateUrls.length} candidates for LTR Match and Flight Risk...`);
                        
                        // Hit the new FastAPI serve_models.py endpoint
                        const response = await fetch('http://localhost:8000/score', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                profile_urls: passedCandidateUrls,
                                jd_text: jdText
                            })
                        });
                        
                        if (!response.ok) {
                            throw new Error(`API returned ${response.status} ${response.statusText}`);
                        }
                        
                        const data = await response.json();
                        riskData = data.scored_candidates || {};
                        
                        await logDebug(`  [Scoring Success] Retrieved scores for ${Object.keys(riskData).length} candidates.`);
                    } catch (error: any) {
                        await logDebug(`  [Scoring Error] Failed to get ML scores: ${error.message}`);
                    }
                    const filteredUrls = passedCandidateUrls.filter(url => {
                        const d = riskData[url];
                        return d ? d.move_prob >= 0.02 : true;
                    });

                    const sortedUrls = [...filteredUrls].sort((a, b) => {
                        const dataA = riskData[a] || { hazard: 0, relevancy: 0, move_prob: 0, tenure: 0 };
                        const dataB = riskData[b] || { hazard: 0, relevancy: 0, move_prob: 0, tenure: 0 };
                        // 1. Sort by LTR Match (Relevancy) descending
                        if (dataB.relevancy !== dataA.relevancy) return dataB.relevancy - dataA.relevancy;
                        // 2. Sort by Flight Risk (Hazard) descending
                        if (dataB.hazard !== dataA.hazard) return dataB.hazard - dataA.hazard;
                        return dataB.tenure - dataA.tenure;
                    });

                    // ── Google Sheets + Email Notification ─────────────
                    const sheetCandidates = sortedUrls.map(url => {
                        const c = pipelineResult.candidates.find(x => x.profile_url === url);
                        return {
                            name: c?.name || 'Unknown',
                            profile_url: url,
                            headline: c?.headline || '',
                            current_company: c?.current_company || '',
                            location: c?.location || ''
                        };
                    });

                    let sheetUrl = '';
                    let newCount = sheetCandidates.length;
                    try {
                        const spreadsheetId = await googleSheetsService.findOrCreateSpreadsheet(jobName, companyName);
                        newCount = await googleSheetsService.appendCandidates(spreadsheetId, sheetCandidates, riskData, testTo);
                        sheetUrl = googleSheetsService.getSpreadsheetUrl(spreadsheetId);
                    } catch (err: any) {
                        await logDebug(`  [GSheets] Failed: ${err.message}. Falling back to email-only.`);
                    }

                    const meta = pipelineResult.meta;
                    const subject = `[🚀 Pipeline] ${newCount} new candidates added for ${jobName} at ${companyName}`;
                    const body = sheetUrl
                        ? [
                            `${newCount} new candidates have been added to the spreadsheet.`,
                            ``,
                            `📊 View spreadsheet: ${sheetUrl}`,
                            ``,
                            `Pipeline stats: Retrieved ${meta.total_retrieved} → Reranked to ${meta.after_rerank} → ${meta.passed_audit} passed audit (${meta.duration_seconds}s)`,
                            `Screening model: ${targetModel}`,
                        ].join('\n')
                        : [
                            `Pipeline stats: Retrieved ${meta.total_retrieved} → Reranked to ${meta.after_rerank} → ${meta.passed_audit} passed audit (${meta.duration_seconds}s)`,
                            ``,
                            `LinkedIn URLs of candidates that passed all screening steps:`,
                            ``,
                            sortedUrls.map(url => {
                                const d = riskData[url] as any;
                                const c = pipelineResult.candidates.find(x => x.profile_url === url);
                                const name = c?.name || '';
                                const fit = c?.audit_fit_score ? `Fit:${c.audit_fit_score}/5` : '';
                                if (!d) return `${name} | ${url} (Risk: N/A${fit ? ' | ' + fit : ''})`;
                                const badge = d.move_prob >= 0.15 ? '[RESTLESS]' : '[STABLE]';
                                return `${badge.padEnd(22)} | Hazard: ${d.hazard.toFixed(2)} | Move Prob: ${(d.move_prob * 100).toFixed(2)}% | ${fit} | URL: ${url}`;
                            }).join('\n'),
                            ``,
                            `---`,
                            `Screening model: ${targetModel}`,
                        ].join('\n');

                    const emailSent = await emailService.sendEmail(subject, body, testTo, testCc);
                    if (emailSent) {
                        for (const url of passedCandidateUrls) {
                            if (url !== 'N/A' && emailsList.length > 0) {
                                await logOutreachSent(url, emailsList, companyName, jobName);
                            }
                        }
                        await logDebug(`  [DB] Marked ${passedCandidateUrls.length} candidates as sent.`);
                    } else {
                        await logDebug(`  ⚠️ Email failed to send — candidates NOT marked as sent.`);
                    }

                    logDebug(`\n[Pipeline] Campaign Complete! ${passedCandidateUrls.length} candidates passed.`);
                    return; // ← exit here, skip standard path
                }
            }
        }
        // ── End Pipeline Path — standard path continues below ────────────────

        // --- Deterministic Same-Company Filter ---
        const GENERIC_SUFFIXES = /\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|株式会社|k\.k\.?|s\.a\.?|b\.v\.?|plc\.?|pty\.?|group|holdings|japan|international|global)\b/gi;
        const hiringCompany = companyName?.trim().toLowerCase() || '';
        const hiringCompanyCanonical = hiringCompany.replace(GENERIC_SUFFIXES, '').replace(/\s+/g, ' ').trim();
        let candidates = uiCandidates.map(c => ({
            name: c.name || c.full_name || 'Unknown',
            profile_url: c.profile_url || c.resume_drive_view_url || 'N/A',
            current_company: c.current_company || c.ai_latest_company || 'N/A',
            location: c.location || c.ai_latest_location || 'N/A',
            summary: c.summary || c.candidate_summary || 'N/A',
            experience: c.experience || c.resume_text_excerpt || 'N/A',
            education: c.education || 'N/A',
            headline: c.headline || c.ai_latest_role || 'N/A',
            skills: c.skills || 'N/A',
            ...c // preserve original fields
        }));
        
        if (hiringCompanyCanonical.length >= 3) {
            const companyTokens = [hiringCompanyCanonical, ...hiringCompanyCanonical.split(/\s+/).filter(t => {
                const clean = t.replace(/[^\w\s]/g, '').trim();
                return clean.length >= 4;
            })];
            const beforeCount = candidates.length;
            candidates = candidates.filter(c => {
                const ccRaw = (c.current_company || '').trim().toLowerCase();
                if (!ccRaw || ccRaw === 'n/a') return true; 
                const cc = ccRaw.replace(GENERIC_SUFFIXES, '').replace(/\s+/g, ' ').trim();
                if (cc.length < 3) return true; 
                const isMatch = companyTokens.some(token => cc.includes(token) || token.includes(cc));
                if (isMatch) {
                    logDebug(`  [Same-Company Filter] EXCLUDED ${c.name}`);
                    logSkipped(c, "Same-Company Filter", `Candidate currently works at "${c.current_company}" which matches hiring company "${companyName}"`);
                }
                return !isMatch;
            });
            logDebug(`\n--- Same-Company Filter: Removed ${beforeCount - candidates.length} candidates (${candidates.length} remaining) ---`);
        }

        if (candidates.length === 0 && screeningEngine !== 'tree' && screeningEngine !== 'tree_llm') return;

        // Pre-load sheet spreadsheet id and existing URLs for incremental inserts
        let spreadsheetId = '';
        let existingSheetUrls = new Set<string>();
        try {
            spreadsheetId = await googleSheetsService.findOrCreateSpreadsheet(jobName, companyName);
            existingSheetUrls = await googleSheetsService.loadExistingUrls(spreadsheetId);
        } catch (err: any) {
            await logDebug(`  [GSheets] Failed to initialize spreadsheet: ${err.message}`);
        }

        const passedCandidateUrls: string[] = [];
        let candidatesToAudit = candidates;

        // Fetch already screened candidates to skip them
        const allProfileUrls = candidatesToAudit.map(c => c.profile_url || 'N/A').filter(url => url !== 'N/A');
        const screenedSet = await getScreenedCandidatesBatch(allProfileUrls, companyName, jobName);

        if (useCompanyIntel) {
            // Batch-load company intel for all candidate employers (single DB query)
            const candidateCompanyNames = candidatesToAudit
                .map(c => c.current_company)
                .filter((n): n is string => !!n && n.trim().length > 0);
            const companyIntelMap = await getCompanyIntelBatch(candidateCompanyNames);
            await logDebug(`  [CompanyIntel] Loaded intel for ${companyIntelMap.size} / ${new Set(candidateCompanyNames.map(n => n.toLowerCase())).size} unique companies.`);

            // Attach company intel to each candidate object
            for (const c of candidatesToAudit) {
                if (c.current_company) {
                    const intel = companyIntelMap.get(c.current_company.trim().toLowerCase());
                    if (intel) {
                        (c as any)._companyIntel = `[Company Intel] ${intel.company_type} | Size: ${intel.size_band} | Flight Risk: ${intel.flight_risk} | Compensation: ${intel.compensation}`;
                    }
                }
            }
        }

        if (screeningEngine === 'tree' || screeningEngine === 'tree_llm') {
            await logDebug(`\n[Tree Scorer] Running ML tree-based candidate scorer for ${candidates.length || 'ALL database'} candidates...`);
            const tmpFile = path.join(process.cwd(), `tree_payload_${Date.now()}.json`);
            fs.writeFileSync(tmpFile, JSON.stringify({ jd: jdText, companyName, candidates, topK: treeTopK }));
            
            try {
                const pythonScript = path.resolve(__dirname, '../../../machine_learning/tree_scorer/jd_tree_scorer.py');
                const pythonDir = path.dirname(pythonScript);
                const { stdout, stderr } = await execPromise(`cat "${tmpFile}" | PYTHONPATH="${pythonDir}" python3 "${pythonScript}" --json`, { maxBuffer: 1024 * 1024 * 50 });
                if (stderr) await logDebug(`  [Tree Warning] ${stderr}`);
                const parsed = JSON.parse(stdout);
                
                if (parsed.error) {
                    await logDebug(`  [Tree Error] ${parsed.error}`);
                } else {
                    const results = parsed.candidates || [];
                    
                    // Reconstruct candidates array if empty (Pure ML Match path)
                    if (candidates.length === 0) {
                        candidates = results.map((r: any) => ({
                            name: r.name,
                            profile_url: r.profile_url,
                            current_company: r.current_company,
                            _treeScore: r.tree_score,
                            _langScore: r.lang_infer_score
                        }));
                    }
                    
                    const passedTreeCandidates = [];
                    for (const r of results) {
                        const candObj = candidates.find(c => c.profile_url === r.profile_url);
                        
                        // Skip if already screened and not doing LLM
                        if (screeningEngine === 'tree' && screenedSet.has(r.profile_url)) {
                            const prevVerdict = screenedSet.get(r.profile_url);
                            if (prevVerdict === 'PASS') passedCandidateUrls.push(r.profile_url);
                            continue;
                        }

                        if (r.tree_score >= 0.5) { // 0.5 Threshold
                            await logDebug(`  ✅ PASS: ${r.name} (Tree: ${r.tree_score.toFixed(3)}, Lang: ${r.lang_infer_score}/3)`);
                            
                            // Save tree verdict
                            await saveScreeningResult(r.profile_url, companyName, jobName, 'PASS', `Tree Score: ${r.tree_score.toFixed(3)}`);
                            
                            if (screeningEngine === 'tree') {
                                passedCandidateUrls.push(r.profile_url);
                                if (candObj) {
                                    await this.savePassedCandidateLogs(candObj, r.profile_url);
                                    if (spreadsheetId) {
                                        await googleSheetsService.appendSingleCandidate(spreadsheetId, candObj, existingSheetUrls, testTo);
                                    }
                                }
                            }
                            if (candObj) {
                                (candObj as any)._treeScore = r.tree_score;
                                (candObj as any)._langScore = r.lang_infer_score;
                                passedTreeCandidates.push(candObj);
                            }
                        } else {
                            await logDebug(`  ❌ FAIL: ${r.name} (Tree: ${r.tree_score.toFixed(3)})`);
                            await saveScreeningResult(r.profile_url, companyName, jobName, 'REJECT', `Tree Score: ${r.tree_score.toFixed(3)}`);
                        }
                    }
                    if (screeningEngine === 'tree_llm') {
                        candidatesToAudit = passedTreeCandidates;
                        await logDebug(`  [Tree Prefilter] ${passedTreeCandidates.length} candidates passed tree scoring and will proceed to LLM screening.`);
                        if (candidatesToAudit.length === 0) {
                            await logDebug(`  ⚠️ No candidates passed the tree pre-filter. Skipping LLM screening.`);
                        }
                    }
                }
            } catch (err: any) {
                await logDebug(`  [Tree Error] Failed execution: ${err.message}`);
            } finally {
                if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
                if (batchId) {
                    const detail = activeBatchDetails.get(batchId);
                    if (detail) {
                        detail.processed += candidates.length;
                        activeBatchDetails.set(batchId, detail);
                    }
                }
            }
        }
        
        if ((screeningEngine === 'llm' || screeningEngine === 'tree_llm') && candidatesToAudit.length > 0) {
            // --- LLM Audit Path with Adaptive Concurrency ---
            const isNvidia = targetModel.startsWith('nvidia:');
            // NVIDIA NIM free tier allows ~40 RPM — start conservatively to avoid burning retries
            const MAX_CONCURRENCY = isNvidia ? 4 : 10;
            const MIN_CONCURRENCY = 1;
            let currentConcurrency = isNvidia ? 2 : 5;
            
            logDebug(`\nStarting adaptive verification pipeline for ${candidatesToAudit.length} candidates using model: ${targetModel} (initial concurrency: ${currentConcurrency}, max: ${MAX_CONCURRENCY})`);
            
            const profileUrls = candidatesToAudit.map(c => c.profile_url || 'N/A').filter(url => url !== 'N/A');
            const alreadySentSet = (!bypassDeduplication && emailsList.length > 0)
                ? await getSentCandidatesBatch(profileUrls, emailsList, companyName)
                : new Set<string>();

            // Track rate-limit backpressure for adaptive concurrency
            let consecutiveSuccesses = 0;
            let rateLimitHits = 0;
            const RAMP_UP_THRESHOLD = 15; // Ramp up after 15 consecutive successes

            // Process candidates in dynamic-sized waves
            let processed = 0;
            const totalToProcess = candidatesToAudit.length;

            while (processed < totalToProcess) {
                const waveSize = Math.min(currentConcurrency, totalToProcess - processed);
                const wave = candidatesToAudit.slice(processed, processed + waveSize);
                const waveStart = Date.now();

                const waveResults = await Promise.allSettled(wave.map(async (candidate, waveIdx) => {
                    const i = processed + waveIdx;
                    const name = candidate.name || 'Unknown';
                    const profileUrl = candidate.profile_url || 'N/A';

                    if (!bypassDeduplication && profileUrl !== 'N/A') {
                        const previousVerdict = screenedSet.get(profileUrl);
                        if (previousVerdict) {
                            await logDebug(`  [Batch#${batchId}] [${i + 1}/${totalToProcess}] ⏭️ SKIPPED (Already screened: ${previousVerdict}): ${name}`);
                            if (previousVerdict === 'PASS') {
                                passedCandidateUrls.push(profileUrl);
                            }
                            if (batchId) {
                                const detail = activeBatchDetails.get(batchId);
                                if (detail) {
                                    detail.processed++;
                                    activeBatchDetails.set(batchId, detail);
                                }
                            }
                            return { status: 'skipped' as const };
                        }
                    }

                    try {
                        const candidateStart = Date.now();
                        const { isMatch, reasoning, auditJson, rateLimited } = await screeningAgent.verificationAgent(jdText, candidate, targetModel, adjacentRoles);
                        const elapsed = ((Date.now() - candidateStart) / 1000).toFixed(1);

                        if (rateLimited) {
                            return { status: 'rate_limited' as const, isMatch, reasoning, auditJson, name, profileUrl, elapsed };
                        }

                        if (isMatch) {
                            await logDebug(`  [Batch#${batchId}] [${i + 1}/${totalToProcess}] ✅ PASS: ${name} (${elapsed}s)`);
                            passedCandidateUrls.push(profileUrl);
                            await saveScreeningResult(profileUrl, companyName, jobName, 'PASS', reasoning);
                            await this.savePassedCandidateLogs(candidate, profileUrl);
                            if (spreadsheetId) {
                                await googleSheetsService.appendSingleCandidate(spreadsheetId, candidate, existingSheetUrls, testTo);
                            }
                        } else {
                            await logDebug(`  [Batch#${batchId}] [${i + 1}/${totalToProcess}] ❌ REJECT: ${name} - ${reasoning} (${elapsed}s)`);
                            await saveScreeningResult(profileUrl, companyName, jobName, 'REJECT', reasoning);
                            await logSkipped(candidate, "Verification Agent", reasoning);
                        }
                        return { status: 'success' as const, isMatch, name };
                    } catch (err: any) {
                        logDebug(`  [Batch#${batchId}] [${i + 1}/${totalToProcess}] ⚠️ ERROR: ${name} - ${err.message}`);
                        return { status: 'error' as const, name };
                    } finally {
                        if (batchId) {
                            const detail = activeBatchDetails.get(batchId);
                            if (detail) {
                                detail.processed++;
                                activeBatchDetails.set(batchId, detail);
                            }
                        }
                    }
                }));

                // Analyze wave results for adaptive concurrency
                let waveRateLimited = false;
                for (const r of waveResults) {
                    if (r.status === 'fulfilled' && r.value.status === 'rate_limited') {
                        waveRateLimited = true;
                        rateLimitHits++;
                    }
                }

                if (waveRateLimited) {
                    const oldConcurrency = currentConcurrency;
                    currentConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(currentConcurrency / 2));
                    consecutiveSuccesses = 0;
                    if (currentConcurrency !== oldConcurrency) {
                        logDebug(`  [Adaptive] ⚡ Rate limit detected — reducing concurrency: ${oldConcurrency} → ${currentConcurrency}`);
                    }
                    // Long cooldown after a rate-limited wave to let the API window fully reset
                    const cooldown = 10000 + Math.random() * 5000;
                    logDebug(`  [Adaptive] Cooling down ${(cooldown / 1000).toFixed(1)}s before next wave...`);
                    await new Promise(resolve => setTimeout(resolve, cooldown));
                } else {
                    consecutiveSuccesses += waveSize;
                    if (consecutiveSuccesses >= RAMP_UP_THRESHOLD && currentConcurrency < MAX_CONCURRENCY) {
                        const oldConcurrency = currentConcurrency;
                        currentConcurrency = Math.min(MAX_CONCURRENCY, currentConcurrency + 1);
                        consecutiveSuccesses = 0;
                        if (currentConcurrency !== oldConcurrency) {
                            logDebug(`  [Adaptive] 🚀 Sustained success — increasing concurrency: ${oldConcurrency} → ${currentConcurrency}`);
                        }
                    }
                    // Brief inter-wave pause even on success to maintain steady throughput
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                processed += waveSize;
                const waveElapsed = ((Date.now() - waveStart) / 1000).toFixed(1);
                if (processed < totalToProcess) {
                    logDebug(`  [Progress] ${processed}/${totalToProcess} candidates processed (wave: ${waveSize} in ${waveElapsed}s, concurrency: ${currentConcurrency}, 429s: ${rateLimitHits})`);
                }
            }

            logDebug(`  [Adaptive Summary] Finished ${totalToProcess} candidates. Total 429 hits: ${rateLimitHits}. Final concurrency: ${currentConcurrency}.`);
        }

        if (passedCandidateUrls.length > 0) {
            // ML Risk Scoring & Sorting
            let riskData: Record<string, { hazard: number, move_prob: number, tenure: number, median_tenure?: number }> = {};
            try {
                await logDebug(`\nScoring ${passedCandidateUrls.length} candidates for attrition risk...`);
                const pythonScript = path.resolve(__dirname, '../../../machine_learning/src/inference.py');
                const pythonDir = path.dirname(pythonScript);
                const { stdout, stderr } = await execPromise(`echo '${JSON.stringify(passedCandidateUrls)}' | PYTHONPATH="${pythonDir}" python3 "${pythonScript}"`);
                if (stderr) await logDebug(`  [Scoring Warning] ${stderr}`);
                riskData = JSON.parse(stdout);
            } catch (error: any) {
                await logDebug(`  [Scoring Error] Failed to get risk scores: ${error.message}`);
            }
            // Filter out extremely stable candidates (e.g. move_prob < 0.02)
            const filteredUrls = passedCandidateUrls.filter(url => {
                const d = riskData[url];
                return d ? d.move_prob >= 0.02 : true;
            });

            // Sort
            const sortedUrls = [...filteredUrls].sort((a, b) => {
                const dataA = riskData[a] || { hazard: 0, move_prob: 0, tenure: 0 };
                const dataB = riskData[b] || { hazard: 0, move_prob: 0, tenure: 0 };
                
                if (dataB.move_prob !== dataA.move_prob) return dataB.move_prob - dataA.move_prob;
                if (dataB.hazard !== dataA.hazard) return dataB.hazard - dataA.hazard;
                return dataB.tenure - dataA.tenure;
            });

            // Backfill ML Risk Scores into Google Sheets
            if (spreadsheetId && Object.keys(riskData).length > 0) {
                await googleSheetsService.backfillRiskScores(spreadsheetId, riskData);
            }
            
            let sheetUrl = spreadsheetId ? googleSheetsService.getSpreadsheetUrl(spreadsheetId) : '';
            let newCount = sortedUrls.length; // Informational only, actual count is dynamically handled during append

            const subject = `${newCount} new candidates added for ${jobName} at ${companyName}`;
            const body = sheetUrl
                ? [
                    `${newCount} new candidates have been added to the spreadsheet.`,
                    ``,
                    `📊 View spreadsheet: ${sheetUrl}`,
                    ``,
                    `---`,
                    `Screening model: ${targetModel}`,
                ].join('\n')
                : (() => {
                    const formattedBodyUrls = sortedUrls.map(url => {
                        const d = riskData[url] as any;
                        const cand = candidates.find(c => c.profile_url === url);
                        const treeStr = cand && cand._treeScore !== undefined ? ` | TreeScore: ${cand._treeScore.toFixed(2)} | Lang: ${cand._langScore}/3` : '';
                        if (!d) return `${url} (Risk: N/A${treeStr})`;
                        const badge = d.move_prob >= 0.15 ? '[RESTLESS]' : '[STABLE]';
                        return `${badge.padEnd(22)} | Hazard: ${d.hazard.toFixed(2)} | Move Prob: ${(d.move_prob * 100).toFixed(2)}% | Tenure: ${d.tenure.toFixed(1)}mo${treeStr} | URL: ${url}`;
                    }).join('\n');
                    return `Here are the LinkedIn URLs of the candidates that passed the verification steps:\n\n${formattedBodyUrls}\n\n---\nScreening model: ${targetModel}`;
                })();

            const emailSent = await emailService.sendEmail(subject, body, testTo, testCc);

            if (emailSent) {
                for (const url of passedCandidateUrls) {
                    if (url !== 'N/A' && emailsList.length > 0) {
                        await logOutreachSent(url, emailsList, companyName, jobName);
                    }
                }
                await logDebug(`  [DB] Marked ${passedCandidateUrls.length} candidates as sent in dedup database.`);
            } else {
                await logDebug(`  ⚠️ Email failed to send — candidates NOT marked as sent. They will be re-processed on next run.`);
            }
        }

        logDebug(`\nCampaign Complete! Processed ${candidates.length} candidates.`);
    }
}

export const outreachService = new OutreachService();
