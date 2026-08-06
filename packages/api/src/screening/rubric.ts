/**
 * rubric.ts — Stage 0: compile a job description into checkable criteria.
 *
 * This is the highest-leverage stage in the pipeline, and the one the previous
 * agent had no equivalent of.
 *
 * Before: the raw JD was pasted into the system prompt on every single call, so
 * the model re-derived "what does this job actually require?" independently for
 * each candidate — and answered it slightly differently each time. Candidate A
 * and candidate B were not judged against the same bar, which makes their
 * verdicts incomparable and makes the whole notion of "accuracy" ill-defined.
 *
 * After: the JD is compiled ONCE per campaign into an explicit rubric, a human
 * can approve it, and every candidate is scored against that identical, frozen
 * artifact. It also converts a large class of disagreement from "the model is
 * wrong" — hard to fix — into "the rubric is wrong", which a recruiter can read
 * and correct in a minute.
 */
import { JdRubric } from './schemas';
import { callStage, modelFor, type TokenUsage } from './llm';
import { getRubric, saveRubric, hashJd } from '../repositories/screening_repo';
import { logInfo, logWarn } from '../utils/logger';

/** Bumped when the prompt below changes materially, so stored rubrics are
 *  traceable to the code that produced them. */
export const RUBRIC_PROMPT_VERSION = 'v1';

const SYSTEM = `You are a hiring analyst. Convert a job description into an explicit, checkable screening rubric.

You are NOT evaluating any candidate. You are defining the bar.

## Rules

1. **Separate knockouts from competencies.**
   - A KNOCKOUT is binary and disqualifying: failing it cannot be compensated
     for by strength elsewhere. Be conservative — most requirements are NOT
     knockouts. A JD saying "5+ years required" is a knockout; "familiarity
     with Kubernetes preferred" is not.
   - A COMPETENCY is scored and weighted. Most requirements belong here.

2. **Mark a knockout as "structured" only if it can be checked against one of
   these fields without reading prose:**
     total_experience_months, location, current_company, latest_role
   Everything else is "evidence" — it needs the resume read.

3. **Weights** reflect the JD's own emphasis. A requirement stated as
   "essential" or repeated across sections outweighs one mentioned in passing.

4. **Do not invent requirements.** If the JD does not state it, it is not in
   the rubric. Inferring unstated requirements is the single most common way a
   screening rubric becomes wrong.

5. **open_questions** is for genuine ambiguity you refuse to resolve on your
   own — conflicting seniority signals, an unstated location policy, a
   requirement that could be read two ways. A human resolves these. Leaving it
   empty when the JD IS ambiguous is worse than listing them.

6. **anti_signals** are concrete, observable patterns that argue against a fit
   for THIS role. Not generic negatives.

## Output

Return ONLY a JSON object:

{
  "role_title": "...",
  "role_summary": "2-3 sentences a downstream evaluator can use INSTEAD of the full JD",
  "seniority_band": "junior|mid|senior|lead|executive|unspecified",
  "min_years_experience": <number or null>,
  "max_years_experience": <number or null>,
  "knockouts": [
    { "id": "ko_1", "requirement": "...", "kind": "structured",
      "field": "total_experience_months", "operator": "gte", "value": 60 },
    { "id": "ko_2", "requirement": "...", "kind": "evidence" }
  ],
  "competencies": [
    { "id": "c_1", "requirement": "...", "weight": 3,
      "evidence_hint": "what strong evidence looks like" }
  ],
  "adjacent_roles": ["..."],
  "anti_signals": ["..."],
  "open_questions": ["..."]
}

Ids must be unique and stable. Use at most 8 knockouts and 12 competencies —
a rubric longer than that is not a bar, it is a wish list.`;

export interface CompiledRubric {
  jdHash: string;
  rubric: JdRubric;
  approved: boolean;
  fromCache: boolean;
  usage: TokenUsage;
}

/**
 * Compiles a JD, reusing a stored rubric when one exists for the same text.
 *
 * The cache is keyed by a hash of the normalised JD, so re-running a campaign
 * costs nothing and — more importantly — reuses the exact rubric a human
 * already approved rather than quietly recompiling a different one.
 */
export async function compileRubric(params: {
  jdText: string;
  jobName?: string;
  companyName?: string;
  forceRecompile?: boolean;
}): Promise<CompiledRubric | null> {
  const jdHash = hashJd(params.jdText);

  if (!params.forceRecompile) {
    const stored = await getRubric(jdHash);
    if (stored) {
      logInfo('rubric_cache_hit', { jdHash, approved: stored.approvedAt !== null });
      return {
        jdHash,
        rubric: stored.rubric,
        approved: stored.approvedAt !== null,
        fromCache: true,
        usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
      };
    }
  }

  const result = await callStage({
    role: 'compiler',
    system: SYSTEM,
    user: `JOB DESCRIPTION\n---\n${params.jdText}\n---\n\nCompile the screening rubric.`,
    schema: JdRubric,
    maxTokens: 4096,
  });

  if (!result.ok || !result.data) {
    logWarn('rubric_compile_failed', { jdHash, error: result.error });
    return null;
  }

  const rubric = normaliseIds(result.data);

  await saveRubric({
    jdHash,
    rubric,
    jobName: params.jobName,
    companyName: params.companyName,
    compiledBy: modelFor('compiler'),
    promptVersion: RUBRIC_PROMPT_VERSION,
  });

  logInfo('rubric_compiled', {
    jdHash,
    knockouts: rubric.knockouts.length,
    competencies: rubric.competencies.length,
    openQuestions: rubric.open_questions.length,
  });

  return { jdHash, rubric, approved: false, fromCache: false, usage: result.usage };
}

/**
 * Guarantees unique, non-empty ids.
 *
 * Downstream stages key evidence and scores by id, so a duplicate id silently
 * merges two different requirements into one — the kind of defect that is
 * invisible in the output and corrupts every score built on it.
 */
function normaliseIds(rubric: JdRubric): JdRubric {
  const seen = new Set<string>();
  const unique = (proposed: string, prefix: string, index: number): string => {
    const base = proposed.trim() || `${prefix}_${index + 1}`;
    let id = base;
    let n = 2;
    while (seen.has(id)) id = `${base}_${n++}`;
    seen.add(id);
    return id;
  };

  return {
    ...rubric,
    knockouts: rubric.knockouts.map((k, i) => ({ ...k, id: unique(k.id, 'ko', i) })),
    competencies: rubric.competencies.map((c, i) => ({ ...c, id: unique(c.id, 'c', i) })),
  };
}

/** Total weight, used to normalise competency scores into 0-1. */
export function totalWeight(rubric: JdRubric): number {
  const sum = rubric.competencies.reduce((acc, c) => acc + (c.weight || 0), 0);
  // A rubric where every weight is zero would divide by zero; treat each
  // competency as equally weighted in that case rather than failing.
  return sum > 0 ? sum : rubric.competencies.length || 1;
}
