import { z } from 'zod';

export const TechAuditItem = z.object({
    requirement: z.string(),
    competency_score: z.string(),
    evidence_quote: z.string(),
    justification: z.string()
});

export const AdversarialFlags = z.object({
    keyword_stuffing_detected: z.boolean(),
    ai_polish_probability: z.number(),
    risk_details: z.string()
});

export const CandidateSummary = z.object({
    name: z.string(),
    verified_seniority: z.string(),
    knockout_criteria_passed: z.boolean()
});

export const CandidateMatch = z.object({
    is_match: z.boolean().describe("True if the candidate is a strong fit for the JD, False otherwise."),
    reasoning: z.string().describe("Brief explanation of why the candidate is or is not a fit.")
});

export const VerificationMatch = z.object({
    candidate_summary: CandidateSummary,
    technical_audit: z.array(TechAuditItem),
    adversarial_flags: AdversarialFlags,
    overall_fit_score: z.string(),
    final_verdict: z.string().describe("RETAIN or REJECT")
});

