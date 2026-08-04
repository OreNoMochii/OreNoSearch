import { z } from 'zod';

export const TechAuditItem = z.object({
    requirement: z.string(),
    competency_score: z.string(),
    evidence_quote: z.string(),
    justification: z.string(),
});

export const AdversarialFlags = z.object({
    keyword_stuffing_detected: z.boolean(),
    ai_polish_probability: z.number(),
    risk_details: z.string(),
});

export const CandidateSummary = z.object({
    name: z.string(),
    verified_seniority: z.string(),
    knockout_criteria_passed: z.boolean(),
});

export const CandidateMatch = z.object({
    is_match: z
        .boolean()
        .describe('True if the candidate is a strong fit for the JD, False otherwise.'),
    reasoning: z.string().describe('Brief explanation of why the candidate is or is not a fit.'),
});

export const VerificationMatch = z.object({
    candidate_summary: CandidateSummary,
    technical_audit: z.array(TechAuditItem),
    adversarial_flags: AdversarialFlags,
    overall_fit_score: z.string(),
    final_verdict: z.string().describe('RETAIN or REJECT'),
});

// ── LLM response parsing (B7) ────────────────────────────────────────────────
/**
 * Lenient parse target for what the model actually returns.
 *
 * VerificationMatch above is the *request* contract handed to the provider via
 * zodResponseFormat. The response was previously only JSON.parse'd, then read
 * with `result.final_verdict.includes(...)` and
 * `result.candidate_summary.verified_seniority` — either of which throws a
 * TypeError on a partial response. That landed in the retry catch and burned
 * roughly 100 seconds of backoff on a failure that could never succeed.
 *
 * Only final_verdict is genuinely required; everything else degrades.
 */
export const VerificationResponse = z.object({
    candidate_summary: CandidateSummary.partial().default({}),
    technical_audit: z.array(TechAuditItem.partial()).default([]),
    adversarial_flags: AdversarialFlags.partial().default({}),
    overall_fit_score: z.union([z.string(), z.number()]).transform(String).default('0'),
    final_verdict: z.string().min(1),
});
export type VerificationResponse = z.infer<typeof VerificationResponse>;

// ── Inbound HTTP request contracts (B1 defence in depth) ─────────────────────
/**
 * A candidate as supplied by the UI.
 *
 * `profile_url` is constrained to a well-formed URL because it flows into the
 * ML scoring subprocess. Combined with the shell-free runner in
 * utils/python_runner.ts this makes shell metacharacters unrepresentable rather
 * than merely escaped. `.passthrough()` keeps unknown fields, which the
 * screening prompt relies on.
 */
export const CandidateInput = z
    .object({
        profile_url: z.string().url().max(500).optional(),
        resume_drive_view_url: z.string().url().max(500).optional(),
        name: z.string().max(255).optional(),
        full_name: z.string().max(255).optional(),
        headline: z.string().max(500).optional(),
        ai_latest_role: z.string().max(500).optional(),
        current_company: z.string().max(255).optional(),
        ai_latest_company: z.string().max(255).optional(),
        location: z.string().max(255).optional(),
        ai_latest_location: z.string().max(255).optional(),
        summary: z.string().max(20_000).optional(),
        candidate_summary: z.string().max(20_000).optional(),
        experience: z.string().max(50_000).optional(),
        resume_text_excerpt: z.string().max(50_000).optional(),
        education: z.string().max(20_000).optional(),
        skills: z.string().max(10_000).optional(),
        email: z.string().max(320).optional(),
        folder_id: z.string().max(500).optional(),
    })
    .passthrough();

export type CandidateInput = z.infer<typeof CandidateInput>;

const emailList = z
    .string()
    .min(1)
    .max(1000)
    .refine(
        (v) =>
            v
                .split(',')
                .map((e) => e.trim())
                .filter(Boolean)
                .every((e) => z.string().email().safeParse(e).success),
        'Must be a comma-separated list of valid email addresses',
    );

/**
 * POST /api/outreach body.
 * Replaces roughly twenty lines of hand-rolled clamping in OutreachController.
 */
export const OutreachRequest = z.object({
    candidates: z.array(CandidateInput).max(100_000).default([]),
    jd: z.string().min(20).max(200_000),
    email: emailList,
    jobName: z.string().min(1).max(255),
    companyName: z.string().min(1).max(255),
    model: z.string().max(200).optional(),
    adjacentRoles: z.string().max(4000).optional(),
    bypassDeduplication: z.boolean().default(false),
    useCompanyIntel: z.boolean().default(true),
    usePipeline: z.boolean().default(false),
    screeningEngine: z.enum(['llm', 'tree', 'tree_llm']).default('llm'),
    topN: z.number().int().min(50).max(1000).default(700),
    topK: z.number().int().min(10).max(500).default(300),
    treeTopK: z.number().int().min(10).max(2000).default(1000),
    minExp: z.number().int().min(0).max(60).optional(),
    maxExp: z.number().int().min(0).max(60).optional(),
});
export type OutreachRequest = z.infer<typeof OutreachRequest>;

/** POST /api/search body. */
export const SqlSearchRequest = z.object({
    andGroups: z
        .array(z.array(z.string().max(200)).max(50))
        .max(20)
        .default([]),
    must: z.array(z.string().max(200)).max(50).default([]),
    should: z.array(z.string().max(200)).max(50).default([]),
    mustNot: z.array(z.string().max(200)).max(50).default([]),
    locations: z.array(z.string().max(200)).max(100).default([]),
    limit: z.number().int().min(1).max(100_000).default(25),
    minExp: z.number().int().min(0).max(60).optional(),
    maxExp: z.number().int().min(0).max(60).optional(),
    excludeCompanies: z.array(z.string().max(255)).max(100).optional(),
    currentRoleKeywords: z.array(z.string().max(200)).max(50).optional(),
});
export type SqlSearchRequest = z.infer<typeof SqlSearchRequest>;

/** POST /api/meili/search body — the browser-facing Meilisearch proxy (B2). */
export const MeiliProxyRequest = z.object({
    index: z.string().max(64),
    query: z.string().max(2000),
    limit: z.number().int().min(1).max(1000).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
    filter: z.string().max(2000).optional(),
    attributesToRetrieve: z.array(z.string().max(64)).max(50).optional(),
});
export type MeiliProxyRequest = z.infer<typeof MeiliProxyRequest>;

/** ML scoring service response shape. */
export const RiskScoreEntry = z.object({
    hazard: z.number().default(0),
    relevancy: z.number().default(0),
    move_prob: z.number().default(0),
    tenure: z.number().default(0),
    median_tenure: z.number().optional(),
});
export const ScoringResponse = z.object({
    scored_candidates: z.record(z.string(), RiskScoreEntry).default({}),
});
export type RiskScoreEntry = z.infer<typeof RiskScoreEntry>;
