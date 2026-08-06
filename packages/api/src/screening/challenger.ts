/**
 * challenger.ts — Stage 5: try to disqualify the candidate.
 *
 * This is where most surviving false positives die.
 *
 * A model asked "is this candidate a fit?" is being invited to confirm. It
 * finds supporting evidence, weighs it favourably, and rationalises away the
 * gaps — not because it is badly prompted, but because that is what the
 * question asks for. Running the same question again, or with a bigger model,
 * mostly produces a more confident version of the same answer.
 *
 * So the question is inverted. The challenger is told the candidate is being
 * advanced and asked to argue against it, on the same verified evidence. Its
 * findings are asymmetric by design: one verified fatal objection rejects,
 * while finding nothing does not promote. That asymmetry is what makes the
 * stage strictly precision-increasing.
 *
 * It runs on a DIFFERENT MODEL FAMILY from the adjudicator (see
 * SCREENING_MODEL_CHALLENGER). A challenger that shares the adjudicator's
 * training shares its blind spots, and two models failing the same way is
 * indistinguishable from one model being right.
 */
import { Challenge, type JdRubric } from './schemas';
import { callStage, type TokenUsage } from './llm';
import { verifyQuote, buildQuotableSource } from './grounding';
import type { VerifiedFinding } from './evidence';
import type { ScreenedCandidate } from '../domain/ports';

const SYSTEM = `You are a skeptical hiring reviewer. A colleague has recommended
advancing this candidate. Your job is to find the strongest reasons NOT to.

You are shown the role's requirements and the verified evidence your colleague
relied on. Look for:

- must-haves that the evidence does not actually establish, only implies
- a seniority or scope mismatch in either direction
- domain adjacency being passed off as domain experience
- a career trajectory inconsistent with the role
- the listed anti-signals
- evidence being read more generously than it deserves

## Rules

1. Quote the profile verbatim to support an objection. Objections whose quotes
   cannot be found in the profile are discarded automatically — an invented
   objection is as useless as invented praise.
2. Severity:
     fatal   — disqualifying on its own; a stated must-have is not met
     serious — a real concern a hiring manager would raise
     minor   — worth noting, not disqualifying
   Reserve "fatal" for genuine must-have failures. Inflating severity to seem
   rigorous destroys the signal this stage exists to provide.
3. If the candidate genuinely holds up, say so: return an empty findings list.
   A challenger that always objects is exactly as useless as one that never
   does.

## Output

{
  "findings": [ { "objection": "...", "quote": "<verbatim or empty>", "severity": "fatal" } ],
  "would_reject": true
}`;

export interface ChallengeResult {
  ok: boolean;
  challenge?: Challenge;
  /** Fatal findings whose quote was verified — these force a rejection. */
  verifiedFatal: number;
  verifiedSerious: number;
  /** Objections discarded because their quote was not in the profile. */
  discarded: number;
  usage: TokenUsage;
}

export async function challenge(
  candidate: ScreenedCandidate,
  findings: readonly VerifiedFinding[],
  rubric: JdRubric,
): Promise<ChallengeResult> {
  const evidenceBlock = findings
    .map((f) => {
      const quotes =
        f.verifiedQuotes.length > 0
          ? f.verifiedQuotes.map((q) => `    • "${q}"`).join('\n')
          : '    (no verified evidence)';
      return `- ${f.requirement}\n${quotes}`;
    })
    .join('\n');

  const mustHaves =
    rubric.knockouts.length > 0
      ? rubric.knockouts.map((k) => `- ${k.requirement}`).join('\n')
      : '(none stated)';
  const antiSignals =
    rubric.anti_signals.length > 0 ? rubric.anti_signals.map((a) => `- ${a}`).join('\n') : '(none)';

  const result = await callStage({
    role: 'challenger',
    system: SYSTEM,
    user: `ROLE
${rubric.role_summary || rubric.role_title}
Seniority band: ${rubric.seniority_band}

MUST-HAVES
${mustHaves}

ANTI-SIGNALS
${antiSignals}

EVIDENCE RELIED ON
${evidenceBlock}

Argue against advancing this candidate.`,
    schema: Challenge,
    maxTokens: 2048,
  });

  if (!result.ok || !result.data) {
    return { ok: false, verifiedFatal: 0, verifiedSerious: 0, discarded: 0, usage: result.usage };
  }

  // The challenger is held to the same evidentiary standard as the extractor.
  // An objection is only allowed to sink a candidate if it can point at
  // something the candidate actually wrote.
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

  let verifiedFatal = 0;
  let verifiedSerious = 0;
  let discarded = 0;
  const kept: Challenge['findings'] = [];

  for (const finding of result.data.findings) {
    const status = verifyQuote(finding.quote, source);

    // An objection with no quote at all is a judgement rather than a citation
    // — kept, but it can never be fatal on its own. Only an objection that
    // cites something real is allowed to reject.
    if (status === 'unverified') {
      discarded++;
      continue;
    }

    kept.push(finding);
    if (status === 'verified') {
      if (finding.severity === 'fatal') verifiedFatal++;
      else if (finding.severity === 'serious') verifiedSerious++;
    }
  }

  return {
    ok: true,
    challenge: { findings: kept, would_reject: result.data.would_reject },
    verifiedFatal,
    verifiedSerious,
    discarded,
    usage: result.usage,
  };
}
