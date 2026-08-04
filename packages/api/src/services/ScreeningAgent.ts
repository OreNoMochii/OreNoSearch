import { zodResponseFormat } from 'openai/helpers/zod';
import { getClient, normaliseModelId } from '../core/llm_client';
import { logInfo, logWarn } from '../utils/logger';
import { VerificationMatch, VerificationResponse } from '../core/schemas';
import { MinGapRateLimiter } from '../utils/rate_limiter';
import path from 'path';
import fs from 'fs';

// ── Per-provider rate limiting (B6) ─────────────────────────────────────────
// NVIDIA NIM's free tier allows roughly 40 requests/minute, hence the 1.5s gap.
const nvidiaLimiter = new MinGapRateLimiter(1_500);
const defaultLimiter = new MinGapRateLimiter(100);

const ROLE_CATEGORIES_MAP = {
    'Software Engineering': ['engineer', 'developer', 'tech lead'],
    'Cloud & Infrastructure': [
        'cloud',
        'solution architect',
        'sre',
        'devops',
        'infrastructure',
        'systems engineer',
        'architect',
    ],
    'Sales & Business Development': [
        'account executive',
        'sales',
        'sdr',
        'bDR',
        'business development',
        'ae',
    ],
    'Product Management': ['product manager', 'pm', 'product owner'],
    'Data Science': ['data scientist', 'data analyst', 'statistician', 'quantitative'],
    'ML & AI Engineering': [
        'machine learning',
        'ai researcher',
        'ml engineer',
        'nlp',
        'computer vision',
    ],
    'Finance & Executive': [
        'cfo',
        'finance',
        'ceo',
        'founder',
        'managing director',
        'general manager',
    ],
    'Customer Success & Ops': ['customer success', 'operations', 'csm', 'support'],
};

function getAtlasBenchmark(jdText: string) {
    try {
        const atlasPath = path.join(process.cwd(), 'data', 'role_atlas.json');
        if (!fs.existsSync(atlasPath)) return '';
        const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));

        let category = 'Other';
        const lowJD = jdText.toLowerCase();
        for (const [cat, keywords] of Object.entries(ROLE_CATEGORIES_MAP)) {
            if (keywords.some((kw) => lowJD.includes(kw))) {
                category = cat;
                break;
            }
        }

        let seniority = 'Mid-Level';
        if (lowJD.includes('senior') || lowJD.includes('lead') || lowJD.includes('staff'))
            seniority = 'Senior';
        if (
            lowJD.includes('chief') ||
            lowJD.includes('vp') ||
            lowJD.includes('executive') ||
            lowJD.includes('head')
        )
            seniority = 'Executive';
        if (lowJD.includes('junior') || lowJD.includes('entry') || lowJD.includes('intern'))
            seniority = 'Junior';

        const key = `${category} | ${seniority}`;
        const benchmark = atlas[key];

        if (benchmark) {
            return `\n## ROLE BENCHMARK (REFERENCE ONLY)\nPattern for ${key}:\n- Typical Score: ${benchmark.benchmark_score}/100\n- Gold Standard Examples:\n  ${benchmark.examples.map((ex: string) => `  * [REFERENCE] ${ex}`).join('\n  ')}\n`;
        }
    } catch (e) {
        console.error('Error loading role atlas:', e);
    }
    return '';
}

export class ScreeningAgent {
    async verificationAgent(
        jdText: string,
        candidate: any,
        model: string = 'deepseek-ai/DeepSeek-V3.2',
        adjacentRoles: string = '',
    ): Promise<{ isMatch: boolean; reasoning: string; auditJson?: string; rateLimited?: boolean }> {
        const name = candidate.name || 'Unknown';
        const benchmarkSection = getAtlasBenchmark(jdText);
        const adjacentRolesPrompt = adjacentRoles
            ? `\nAdjacent Roles: You MUST also consider titles like ${adjacentRoles} as functionally equivalent to the target role if the candidate's skills align. Focus on core competencies and functional alignment over nominal job titles.\n`
            : '';

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

        // ── Payload trimming ────────────────────────────────────────────────
        // These bindings exist only to remove the fields from screeningData.
        // Stripping phone_number/email matters: without it, candidate PII is
        // sent to a third-party LLM provider on every screening call.
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const {
            raw,
            phone_number,
            email,
            licenses,
            scraped_at,
            _treeScore,
            _langScore,
            ...screeningData
        } = candidate;
        /* eslint-enable @typescript-eslint/no-unused-vars */
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

        const totalExp = candidate.total_working_experience || '';
        const cleanProfile = JSON.stringify(screeningData);

        const isNvidia = model.startsWith('nvidia:');
        const isLegacyModel =
            model.includes('stepfun') ||
            model.includes('MiniMax') ||
            model.includes('glm') ||
            model.includes('nemotron-3') ||
            (!isNvidia && model.toLowerCase().includes('deepseek-v4'));
        const cleanModel = normaliseModelId(model);
        const apiClient = getClient(model);
        const limiter = isNvidia ? nvidiaLimiter : defaultLimiter;

        const maxRetries = 5;
        let wasRateLimited = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // B6: atomic slot reservation, serialised across concurrent callers.
                await limiter.acquire();

                if (attempt > 1) {
                    logInfo('verification_retry', { attempt, maxRetries, name });
                }

                const displayExp = totalExp
                    ? totalExp
                    : 'Not provided. Please calculate total years of experience by carefully analyzing the duration of their past roles in the experience section.';

                const requestPayload: any = {
                    model: cleanModel,
                    messages: [
                        {
                            role: 'system',
                            content:
                                systemPrompt +
                                '\n\nCRITICAL: Return ONLY a valid JSON object. No other text.',
                        },
                        {
                            role: 'user',
                            content: `CANDIDATE TO SCREEN:\n${cleanProfile}\n\nGROUND TRUTH SENIORITY: ${displayExp}\n\nScreen the candidate above based on the JD and Benchmarks provided in the system instructions.`,
                        },
                    ],
                };

                if (!isLegacyModel) {
                    requestPayload.response_format = zodResponseFormat(
                        VerificationMatch,
                        'verification_match',
                    );
                }

                if (
                    model.toLowerCase().includes('gpt-oss-120') ||
                    model.toLowerCase().includes('deepseek-v4')
                ) {
                    requestPayload.max_tokens = 16384;
                    if (
                        model.startsWith('nvidia:') &&
                        model.toLowerCase().includes('deepseek-v4')
                    ) {
                        requestPayload.reasoning_effort = 'max';
                    } else {
                        requestPayload.reasoning_effort = 'high';
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
                // B7: validate rather than trust. The previous code read
                // result.final_verdict.includes(...) and
                // result.candidate_summary.verified_seniority directly, either of
                // which throws a TypeError on a partial response — landing in the
                // catch below and burning ~100s of backoff on a failure that
                // could never succeed.
                const parsed = VerificationResponse.safeParse(JSON.parse(jsonStr));
                if (!parsed.success) {
                    logWarn('llm_schema_violation', {
                        name,
                        issues: parsed.error.issues
                            .slice(0, 3)
                            .map((i) => `${i.path.join('.')}: ${i.message}`),
                    });
                    // Deterministic failure — retrying cannot help.
                    return {
                        isMatch: false,
                        reasoning: `Malformed LLM response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
                    };
                }
                const result = parsed.data;

                const isMatch = result.final_verdict.toUpperCase().includes('RETAIN');

                // Extract actual reasons for failure from the technical audit
                let rejectionReasons: string[] = [];
                if (!isMatch && result.technical_audit.length > 0) {
                    const scoreOf = (a: { competency_score?: string }): number =>
                        Number.parseInt(a.competency_score ?? '', 10);

                    let failures = result.technical_audit.filter((a) => {
                        const s = scoreOf(a);
                        return Number.isFinite(s) && s <= 2;
                    });

                    // If no 1s or 2s, pull any 3s to show where the weakness was.
                    if (failures.length === 0) {
                        failures = result.technical_audit.filter((a) => {
                            const s = scoreOf(a);
                            return Number.isFinite(s) && s <= 3;
                        });
                    }

                    if (failures.length > 0) {
                        rejectionReasons = failures.map(
                            (f) =>
                                `[${f.requirement ?? 'requirement'}: ${f.justification ?? 'no justification given'}]`,
                        );
                    } else if (
                        result.adversarial_flags.risk_details &&
                        result.adversarial_flags.risk_details !== 'None'
                    ) {
                        rejectionReasons.push(`[Risk: ${result.adversarial_flags.risk_details}]`);
                    } else {
                        rejectionReasons.push('[General Fit: mismatch despite passing technicals]');
                    }
                }

                const techFeedback =
                    rejectionReasons.length > 0 ? ` | Failures: ${rejectionReasons.join(' ')}` : '';

                const seniority = result.candidate_summary.verified_seniority ?? 'unspecified';
                const reasoning =
                    `Verdict: ${result.final_verdict}. Score: ${result.overall_fit_score}. ` +
                    `Seniority: ${seniority}${techFeedback}`;

                return { isMatch, reasoning, auditJson: JSON.stringify(result, null, 2) };
            } catch (error: unknown) {
                const err = error as { status?: number; message?: string };
                const status = err.status;
                const message = err.message ?? String(error);
                const is429 = status === 429 || message.includes('429');
                if (is429) wasRateLimited = true;

                // Only retry what a retry could plausibly fix. Previously a 400
                // (bad request) was retried five times with the same backoff as
                // a 429, wasting roughly 100 seconds per candidate.
                const isRetryable =
                    is429 || status === undefined || status >= 500 || status === 408;

                if (!isRetryable) {
                    logWarn('llm_non_retryable_error', { name, status, message });
                    return {
                        isMatch: false,
                        reasoning: `LLM error ${status}: ${message}`,
                        rateLimited: wasRateLimited,
                    };
                }

                logWarn('llm_attempt_failed', { name, attempt, maxRetries, status, message });

                if (attempt < maxRetries) {
                    // Exponential backoff with jitter, tuned for NVIDIA NIM's
                    // rate-limit window: ~8s, ~15s, ~30s, ~45s.
                    const backoffSeconds = [8, 15, 30, 45];
                    const waitMs =
                        (backoffSeconds[attempt - 1] ?? 45) * 1000 + Math.random() * 5000;
                    if (is429) {
                        logInfo('llm_backoff', { name, waitSeconds: (waitMs / 1000).toFixed(1) });
                    }
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                } else {
                    return { isMatch: false, reasoning: message, rateLimited: wasRateLimited };
                }
            }
        }
        return {
            isMatch: false,
            reasoning: 'All retry attempts failed',
            rateLimited: wasRateLimited,
        };
    }
}

export const screeningAgent = new ScreeningAgent();
