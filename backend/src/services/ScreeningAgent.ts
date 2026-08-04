import { zodResponseFormat } from 'openai/helpers/zod';
import { getClient } from '../core/llm_client';
import { logDebug, logSkipped } from '../utils/logger';
import { CandidateMatch, VerificationMatch } from '../core/schemas';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';

// ── Global rate-limiter: enforces a minimum gap between any two LLM requests ──
let _lastRequestTime = 0;
const MIN_REQUEST_GAP_MS = 1500; // 1.5s between requests to stay under ~40 RPM

async function acquireSlot(): Promise<void> {
    const now = Date.now();
    const elapsed = now - _lastRequestTime;
    if (elapsed < MIN_REQUEST_GAP_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_GAP_MS - elapsed));
    }
    _lastRequestTime = Date.now();
}

const ROLE_CATEGORIES_MAP = {
    'Software Engineering': ['engineer', 'developer', 'tech lead'],
    'Cloud & Infrastructure': ['cloud', 'solution architect', 'sre', 'devops', 'infrastructure', 'systems engineer', 'architect'],
    'Sales & Business Development': ['account executive', 'sales', 'sdr', 'bDR', 'business development', 'ae'],
    'Product Management': ['product manager', 'pm', 'product owner'],
    'Data Science': ['data scientist', 'data analyst', 'statistician', 'quantitative'],
    'ML & AI Engineering': ['machine learning', 'ai researcher', 'ml engineer', 'nlp', 'computer vision'],
    'Finance & Executive': ['cfo', 'finance', 'ceo', 'founder', 'managing director', 'general manager'],
    'Customer Success & Ops': ['customer success', 'operations', 'csm', 'support']
};

function getAtlasBenchmark(jdText: string) {
    try {
        const atlasPath = path.join(process.cwd(), 'data', 'role_atlas.json');
        if (!fs.existsSync(atlasPath)) return "";
        const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));

        let category = 'Other';
        const lowJD = jdText.toLowerCase();
        for (const [cat, keywords] of Object.entries(ROLE_CATEGORIES_MAP)) {
            if (keywords.some(kw => lowJD.includes(kw))) {
                category = cat;
                break;
            }
        }

        let seniority = 'Mid-Level';
        if (lowJD.includes('senior') || lowJD.includes('lead') || lowJD.includes('staff')) seniority = 'Senior';
        if (lowJD.includes('chief') || lowJD.includes('vp') || lowJD.includes('executive') || lowJD.includes('head')) seniority = 'Executive';
        if (lowJD.includes('junior') || lowJD.includes('entry') || lowJD.includes('intern')) seniority = 'Junior';

        const key = `${category} | ${seniority}`;
        const benchmark = atlas[key];

        if (benchmark) {
            return `\n## ROLE BENCHMARK (REFERENCE ONLY)\nPattern for ${key}:\n- Typical Score: ${benchmark.benchmark_score}/100\n- Gold Standard Examples:\n  ${benchmark.examples.map((ex: string) => `  * [REFERENCE] ${ex}`).join('\n  ')}\n`;
        }
    } catch (e) {
        console.error("Error loading role atlas:", e);
    }
    return "";
}

export class ScreeningAgent {

    async verificationAgent(jdText: string, candidate: any, model: string = "deepseek-ai/DeepSeek-V3.2", adjacentRoles: string = ""): Promise<{ isMatch: boolean; reasoning: string; auditJson?: string; rateLimited?: boolean }> {
        const name = candidate.name || 'Unknown';
        const benchmarkSection = getAtlasBenchmark(jdText);
        const adjacentRolesPrompt = adjacentRoles
            ? `\nAdjacent Roles: You MUST also consider titles like ${adjacentRoles} as functionally equivalent to the target role if the candidate's skills align. Focus on core competencies and functional alignment over nominal job titles.\n`
            : "";

        const systemPrompt = `
You are an expert Talent Sourcing Consultant. Your mission is to evaluate a candidate's resume against a specific job description.
Look for general alignment, strong potential, and relevant fundamental skills. Lean towards inclusion rather than hyper-restriction.

## CORE DIRECTIVES

1. **General Requirements Matching**: Enforce core domain "Must-Haves" from the JD but be open to transferable skills. ${adjacentRolesPrompt}

2. **Seniority & Impact**:
   - Align seniority with the JD. 
   - **Crucial Rule**: You MUST accurately report the candidate's total years of experience in the \`verified_seniority\` field based on the \`total_working_experience\` field or by summing their roles. Do NOT ever output "0 years" if they clearly have years of experience listed.
   - If a candidate is vastly overqualified (e.g., 15 years for a 3-year role), you may reject them for "Seniority Drift", but you MUST still report their actual 15 years of experience in the summary. Do not lie and say they have 0 years just to reject them.

3. **Stability & Recent Trajectory**:
   - **Nuanced Stability**: A 1.5 - 2 year tenure is standard in modern tech. Only REJECT for "Job Hopping" if there are multiple consecutive stints < 12 months without clear progression.
   - **Recent Move**: If the last position started < 6 months ago, investigate if it's a temp/contract role or a clear mismatch. Otherwise, be inclusive.
   - **CEO/Founders**: Generally ignore active Founders/CEOs unless the JD is for a C-suite role.

4. **Credential Standards**:
   - Top-tier credentials (universities/companies) are "boosters" but NOT mandatory. Value solid experience at mid-tier firms equally if the skills match.

${benchmarkSection}

## LOGICAL DEMONSTRATIONS (FEW-SHOT)

### EXAMPLE 1: Overqualified Veteran (REJECT)
**Candidate Profile**: 15 yrs total. Applied for a Mid-Level (3-5 yr) role.
**Reasoning**: The candidate is significantly overqualified for this role and will likely churn or be too expensive.
**Verdict**: REJECT

### EXAMPLE 2: Solid Professional (RETAIN)
**Candidate Profile**: 5 yrs total. 2.5 yrs at Company A, 2 yrs at Company B. Solid domain skills.
**Reasoning**: This candidate shows healthy stability (2+ years per role) and consistent growth. Functional experience is a strong match.
**Verdict**: RETAIN

### EXAMPLE 3: Chronic Job Hopper (REJECT)
**Candidate Profile**: 8 yrs total. 5 companies in last 4 years (all < 10 months). No promotions.
**Reasoning**: The candidate has a clear pattern of leaving roles before reaching 1 year of tenure. This is a stability risk regardless of skill level.
**Verdict**: REJECT

## EVALUATION RUBRIC (1-5 Scale)
5: Excellent Match. 4: Strong Match. 3: Solid Fit / High Potential (Junior). 2: Below Requirements. 1: Significant Gap.
ONLY return a 'REJECT' verdict if the score is 1 or 2. For Juniors, a score of 3 (Potential) is a RETAIN.

--- JOB DESCRIPTION ---
${jdText}
-----------------------

## OUTPUT SPECIFICATION
Return ONLY a valid JSON object. No other text. Every field MUST be a string or boolean as specified.

JSON
{
    "candidate_summary": {
        "name": "Full Name",
        "verified_seniority": "Must state the ACTUAL years of experience (e.g., '15 years total / Overqualified' or '4 years total / Mid-level'). Do NOT write 0 unless they truly have no experience.",
        "knockout_criteria_passed": true/false
    },
    "technical_audit": [
        {
            "requirement": "Requirement name (must be a string)",
            "competency_score": "1-5 (string)",
            "evidence_quote": "Verbatim quote or 'No evidence found'",
            "justification": "Why this score was given"
        }
    ],
    "adversarial_flags": {
        "keyword_stuffing_detected": false,
        "ai_polish_probability": 0.0,
        "risk_details": "None"
    },
    "overall_fit_score": "1-5",
    "final_verdict": "RETAIN or REJECT"
}

CRITICAL: If data for a requirement is missing, set evidence_quote to "No evidence found" and score it appropriately. DO NOT omit any fields.`;

        // ── Payload Trimming: strip irrelevant fields & truncate long text ──
        const { raw, phone_number, email, licenses, scraped_at, _treeScore, _langScore, ...screeningData } = candidate;
        if (screeningData.experience && screeningData.experience.length > 3000) {
            screeningData.experience = screeningData.experience.slice(0, 3000) + '... [truncated]';
        }
        if (screeningData.education && screeningData.education.length > 2000) {
            screeningData.education = screeningData.education.slice(0, 2000) + '... [truncated]';
        }
        if (screeningData.summary && screeningData.summary.length > 1500) {
            screeningData.summary = screeningData.summary.slice(0, 1500) + '... [truncated]';
        }
        if (screeningData.skills && screeningData.skills.length > 1000) {
            screeningData.skills = screeningData.skills.slice(0, 1000) + '... [truncated]';
        }

        const totalExp = candidate.total_working_experience || "";
        const cleanProfile = JSON.stringify(screeningData);

        const isNvidia = model.startsWith('nvidia:');
        const isLegacyModel = model.includes('stepfun') || model.includes('MiniMax') || model.includes('glm') || model.includes('nemotron-3') || (!isNvidia && model.toLowerCase().includes('deepseek-v4'));
        const cleanModel = model.startsWith('nvidia:') ? model.replace('nvidia:', '') : model;
        const apiClient = getClient(model);

        const maxRetries = 5;
        let wasRateLimited = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Acquire a global rate-limiter slot before every API call
                await acquireSlot();

                if (attempt > 1) {
                    logDebug(`  [Verification] Retry ${attempt}/${maxRetries} for ${name}...`);
                }

                const displayExp = totalExp ? totalExp : "Not provided. Please calculate total years of experience by carefully analyzing the duration of their past roles in the experience section.";

                let requestPayload: any = {
                    model: cleanModel,
                    messages: [
                        { role: "system", content: systemPrompt + "\n\nCRITICAL: Return ONLY a valid JSON object. No other text." },
                        { role: "user", content: `CANDIDATE TO SCREEN:\n${cleanProfile}\n\nGROUND TRUTH SENIORITY: ${displayExp}\n\nScreen the candidate above based on the JD and Benchmarks provided in the system instructions.` }
                    ]
                };

                if (!isLegacyModel) {
                    requestPayload.response_format = zodResponseFormat(VerificationMatch, 'verification_match');
                }

                if (model.toLowerCase().includes('gpt-oss-120') || model.toLowerCase().includes('deepseek-v4')) {
                    requestPayload.max_tokens = 16384; 
                    if (model.startsWith('nvidia:') && model.toLowerCase().includes('deepseek-v4')) {
                        requestPayload.reasoning_effort = "max";
                    } else {
                        requestPayload.reasoning_effort = "high";
                    }
                }

                const completion = await apiClient.chat.completions.create(requestPayload);
                const content = completion.choices[0].message.content || '';
                
                let jsonStr = content.trim();
                jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, '');
                jsonStr = jsonStr.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
                jsonStr = jsonStr.trim();
                const firstBrace = jsonStr.indexOf('{');
                if (firstBrace !== -1) {
                    const lastBrace = jsonStr.lastIndexOf('}');
                    if (lastBrace > firstBrace) {
                        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
                    }
                }
                const result = JSON.parse(jsonStr);

                if (!result) return { isMatch: false, reasoning: "No result" };

                const isMatch = result.final_verdict === "RETAIN" || result.final_verdict.includes("RETAIN");
                
                // Extract actual reasons for failure from the technical audit
                let rejectionReasons: string[] = [];
                if (!isMatch && Array.isArray(result.technical_audit)) {
                    let failures = result.technical_audit.filter((a: any) => {
                        const score = parseInt(a.competency_score, 10);
                        return !isNaN(score) && score <= 2;
                    });
                    
                    // If no 1s or 2s, but they still got rejected, pull any 3s to see what the weakness was
                    if (failures.length === 0) {
                        failures = result.technical_audit.filter((a: any) => {
                            const score = parseInt(a.competency_score, 10);
                            return !isNaN(score) && score <= 3;
                        });
                    }
                    
                    if (failures.length > 0) {
                        rejectionReasons = failures.map((f: any) => `[${f.requirement}: ${f.justification}]`);
                    } else if (result.adversarial_flags?.risk_details && result.adversarial_flags.risk_details !== "None") {
                        rejectionReasons.push(`[Risk: ${result.adversarial_flags.risk_details}]`);
                    } else {
                        rejectionReasons.push(`[General Fit: Evaluated as a mismatch despite passing technicals]`);
                    }
                }
                
                const techFeedback = rejectionReasons.length > 0 
                    ? ` | Failures: ${rejectionReasons.join(' ')}` 
                    : '';

                const reasoning = `Verdict: ${result.final_verdict}. Score: ${result.overall_fit_score}. Seniority: ${result.candidate_summary.verified_seniority}${techFeedback}`;

                return { isMatch, reasoning, auditJson: JSON.stringify(result, null, 2) };
            } catch (error: any) {
                const is429 = error.status === 429 || (error.message && error.message.includes('429'));
                if (is429) wasRateLimited = true;

                const statusInfo = error.status ? ` (HTTP ${error.status})` : '';
                logDebug(`  [Attempt ${attempt}/${maxRetries}] Failed for ${name}: ${error.message}${statusInfo}`);
                if (attempt < maxRetries) {
                    // Long exponential backoff with jitter specifically tuned for NVIDIA NIM rate limits
                    // Delays: ~8s, ~15s, ~30s, ~45s — gives the rate-limit window time to fully reset
                    const backoffSeconds = [8, 15, 30, 45];
                    const baseMs = (backoffSeconds[attempt - 1] || 45) * 1000;
                    const jitterMs = Math.random() * 5000;
                    const waitMs = baseMs + jitterMs;
                    if (is429) {
                        logDebug(`  [Rate Limit] Backing off ${(waitMs / 1000).toFixed(1)}s before retry...`);
                    }
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                } else {
                    return { isMatch: false, reasoning: error.message, rateLimited: wasRateLimited };
                }
            }
        }
        return { isMatch: false, reasoning: "All retry attempts failed", rateLimited: wasRateLimited };
    }
}

export const screeningAgent = new ScreeningAgent();
