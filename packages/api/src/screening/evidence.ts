/**
 * evidence.ts — Stage 3: extract quotes, then verify they are real.
 *
 * The extraction call is the cheap part. The verification that follows it is
 * the point of the stage.
 *
 * Every screening prompt in this codebase has always asked for "verbatim
 * quotes", and nothing ever checked. A model that invents a supporting quote
 * therefore produced a confident, well-cited PASS resting on a sentence that
 * does not exist. You cannot instruct your way out of this — the instruction
 * was already there. You can only check.
 *
 * So: extract, then discard anything not found in the candidate's own text.
 * The adjudicator downstream never sees an unverified quote, which means a
 * fabrication cannot contribute to a score at all. It is deterministic, it is
 * free, and it removes an entire class of false positive.
 */
import type { ScreenedCandidate } from '../domain/ports';
import { EvidenceBundle, type JdRubric } from './schemas';
import { callStage, emptyUsage, type TokenUsage } from './llm';
import { buildQuotableSource, verifyQuote, type GroundingStatus } from './grounding';

export interface VerifiedFinding {
  requirementId: string;
  requirement: string;
  /** Quotes confirmed to exist in the profile. Only these reach scoring. */
  verifiedQuotes: string[];
  /** Quotes the model produced that are not in the profile. Retained for
   *  reporting — a model with a high rate here is not trustworthy. */
  fabricatedQuotes: string[];
  addressed: boolean;
}

export interface EvidenceResult {
  findings: VerifiedFinding[];
  verifiedCount: number;
  fabricatedCount: number;
  usage: TokenUsage;
  ok: boolean;
}

const SYSTEM = `You extract evidence from a candidate profile. You do NOT evaluate or score.

For each listed requirement, find passages in the profile that speak to it —
for or against.

## Rules

1. Quotes MUST be copied character-for-character from the profile. Do not
   paraphrase, summarise, correct, or join fragments from different places.
2. If the profile says nothing about a requirement, return an empty quote list
   and set "addressed": false. This is a correct and expected answer. An honest
   empty result is worth far more than an invented one.
3. Never write a quote that is not in the text. Fabricated quotes are detected
   automatically and discarded, and they count against the extraction.
4. Prefer specific passages — a role, a duration, a named system, a measurable
   outcome — over generic statements.
5. At most 3 quotes per requirement. Pick the strongest.

## Output

{
  "findings": [
    { "requirement_id": "<id>", "quotes": ["<verbatim>"], "addressed": true }
  ]
}

Include an entry for EVERY requirement id given, even when empty.`;

/** Renders the candidate for the model, with generous but bounded fields. */
function renderProfile(candidate: ScreenedCandidate): string {
  const section = (label: string, value: string | undefined, limit: number): string =>
    value && value.trim() ? `## ${label}\n${value.slice(0, limit)}\n` : '';

  return [
    `## NAME\n${candidate.name}\n`,
    section('CURRENT ROLE', candidate.headline, 500),
    section('CURRENT COMPANY', candidate.currentCompany, 300),
    section('LOCATION', candidate.location, 200),
    section('SUMMARY', candidate.summary, 4_000),
    section('EXPERIENCE', candidate.experience, 12_000),
    section('EDUCATION', candidate.education, 3_000),
    section('SKILLS', candidate.skills, 2_000),
  ].join('');
}

export async function extractEvidence(
  candidate: ScreenedCandidate,
  rubric: JdRubric,
): Promise<EvidenceResult> {
  // Evidence-kind knockouts and all competencies need the text read; the
  // structured knockouts were already settled by the gates.
  const requirements = [
    ...rubric.knockouts
      .filter((k) => k.kind === 'evidence')
      .map((k) => ({ id: k.id, text: `[MUST-HAVE] ${k.requirement}`, hint: '' })),
    ...rubric.competencies.map((c) => ({
      id: c.id,
      text: c.requirement,
      hint: c.evidence_hint,
    })),
  ];

  if (requirements.length === 0) {
    return {
      findings: [],
      verifiedCount: 0,
      fabricatedCount: 0,
      usage: emptyUsage(),
      ok: true,
    };
  }

  const requirementBlock = requirements
    .map(
      (r) => `- id: ${r.id}\n  requirement: ${r.text}${r.hint ? `\n  looks like: ${r.hint}` : ''}`,
    )
    .join('\n');

  const result = await callStage({
    role: 'extractor',
    system: SYSTEM,
    user: `ROLE\n${rubric.role_summary || rubric.role_title}\n\nREQUIREMENTS\n${requirementBlock}\n\nCANDIDATE PROFILE\n${renderProfile(candidate)}\n\nExtract evidence for every requirement id.`,
    schema: EvidenceBundle,
    maxTokens: 3072,
  });

  if (!result.ok || !result.data) {
    return {
      findings: [],
      verifiedCount: 0,
      fabricatedCount: 0,
      usage: result.usage,
      ok: false,
    };
  }

  // ── Verification ──────────────────────────────────────────────────────────
  // Built once per candidate, not once per quote.
  const source = buildQuotableSource({
    name: candidate.name,
    headline: candidate.headline,
    current_company: candidate.currentCompany,
    location: candidate.location,
    summary: candidate.summary,
    experience: candidate.experience,
    education: candidate.education,
    skills: candidate.skills,
  });

  const byId = new Map(requirements.map((r) => [r.id, r.text]));
  const findings: VerifiedFinding[] = [];
  let verifiedCount = 0;
  let fabricatedCount = 0;

  for (const finding of result.data.findings) {
    const requirement = byId.get(finding.requirement_id);
    // A finding for an id that is not in the rubric is noise — most often the
    // model inventing a requirement. Dropped rather than scored.
    if (!requirement) continue;

    const verified: string[] = [];
    const fabricated: string[] = [];

    for (const quote of finding.quotes) {
      const status: GroundingStatus = verifyQuote(quote, source);
      if (status === 'verified') verified.push(quote);
      else if (status === 'unverified') fabricated.push(quote);
      // 'abstained' and 'trivial' are neither evidence nor fabrication.
    }

    verifiedCount += verified.length;
    fabricatedCount += fabricated.length;

    findings.push({
      requirementId: finding.requirement_id,
      requirement,
      verifiedQuotes: verified,
      fabricatedQuotes: fabricated,
      // A requirement is only "addressed" if something survived verification.
      // Trusting the model's own flag here would let a fabrication mark a
      // requirement as met.
      addressed: verified.length > 0,
    });
  }

  // Requirements the model omitted entirely are unaddressed, not absent.
  for (const r of requirements) {
    if (!findings.some((f) => f.requirementId === r.id)) {
      findings.push({
        requirementId: r.id,
        requirement: r.text,
        verifiedQuotes: [],
        fabricatedQuotes: [],
        addressed: false,
      });
    }
  }

  return { findings, verifiedCount, fabricatedCount, usage: result.usage, ok: true };
}
