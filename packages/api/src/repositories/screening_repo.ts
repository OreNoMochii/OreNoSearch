/**
 * screening_repo.ts — persistence for the agentic screening pipeline.
 *
 * See packages/scraper/migrations/007_agentic_screening.sql for the schema and
 * the reasoning behind each table.
 */
import { createHash } from 'crypto';
import { pool } from './postgres_repo';
import { JdRubric } from '../screening/schemas';
import type { Decision, DecisionStage } from '../screening/schemas';
import { logWarn } from '../utils/logger';

/**
 * Identity of a job description.
 *
 * Whitespace-normalised before hashing so that a reformatted-but-identical JD
 * reuses its approved rubric instead of silently compiling a new one and
 * losing the human sign-off.
 */
export function hashJd(jdText: string): string {
  const normalised = jdText.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 32);
}

export interface StoredRubric {
  jdHash: string;
  rubric: JdRubric;
  approvedAt: Date | null;
  approvedBy: string | null;
  compiledBy: string | null;
}

export async function getRubric(jdHash: string): Promise<StoredRubric | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT jd_hash, rubric, approved_at, approved_by, compiled_by
       FROM jd_rubrics WHERE jd_hash = $1`,
      [jdHash],
    );
    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    // Validate on the way out: a rubric written by an older prompt revision
    // may not match the current shape, and finding that out here is far better
    // than a field access failing mid-campaign.
    const parsed = JdRubric.safeParse(row.rubric);
    if (!parsed.success) {
      logWarn('stored_rubric_invalid', {
        jdHash,
        issue: parsed.error.issues[0]?.message,
      });
      return null;
    }

    return {
      jdHash: row.jd_hash as string,
      rubric: parsed.data,
      approvedAt: row.approved_at as Date | null,
      approvedBy: row.approved_by as string | null,
      compiledBy: row.compiled_by as string | null,
    };
  } finally {
    client.release();
  }
}

export async function saveRubric(params: {
  jdHash: string;
  rubric: JdRubric;
  jobName?: string;
  companyName?: string;
  compiledBy: string;
  promptVersion: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    // Deliberately does NOT clear approved_at on conflict: the hash covers the
    // JD text, so the same hash means the same JD, and a re-compile of an
    // unchanged JD should not silently discard a human's sign-off.
    await client.query(
      `INSERT INTO jd_rubrics
         (jd_hash, job_name, company_name, rubric, compiled_by, prompt_version, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
       ON CONFLICT (jd_hash) DO UPDATE SET
         rubric         = EXCLUDED.rubric,
         job_name       = COALESCE(EXCLUDED.job_name, jd_rubrics.job_name),
         company_name   = COALESCE(EXCLUDED.company_name, jd_rubrics.company_name),
         compiled_by    = EXCLUDED.compiled_by,
         prompt_version = EXCLUDED.prompt_version,
         updated_at     = now()`,
      [
        params.jdHash,
        params.jobName ?? null,
        params.companyName ?? null,
        JSON.stringify(params.rubric),
        params.compiledBy,
        params.promptVersion,
      ],
    );
  } finally {
    client.release();
  }
}

export async function approveRubric(jdHash: string, approvedBy: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE jd_rubrics SET approved_at = now(), approved_by = $2, updated_at = now()
       WHERE jd_hash = $1`,
      [jdHash, approvedBy],
    );
    return (res.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// ── Audit trail ─────────────────────────────────────────────────────────────

export interface AuditRow {
  runId: string;
  profileUrl: string;
  jdHash: string;
  companyName?: string;
  jobName?: string;
  decision: Decision;
  decidedAtStage: DecisionStage;
  confidence: number | null;
  gateResult?: unknown;
  prefilterScore?: number | null;
  evidence?: unknown;
  adjudication?: unknown;
  challenge?: unknown;
  quotesVerified: number;
  quotesUnverified: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  durationMs: number;
}

/**
 * Writes audit rows for a whole wave in one statement.
 *
 * Per-row inserts here would reintroduce exactly the pool-starvation problem
 * that batching the screening verdicts fixed: this runs once per candidate, on
 * the same shared 20-connection pool the search path uses.
 */
export async function saveAuditBatch(rows: readonly AuditRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO screening_audit (
         run_id, profile_url, jd_hash, company_name, job_name,
         decision, decided_at_stage, confidence,
         gate_result, prefilter_score, evidence, adjudication, challenge,
         quotes_verified, quotes_unverified,
         prompt_tokens, completion_tokens, llm_calls, duration_ms
       )
       SELECT * FROM unnest(
         $1::text[],  $2::text[],  $3::text[],  $4::text[],  $5::text[],
         $6::text[],  $7::text[],  $8::numeric[],
         $9::jsonb[], $10::numeric[], $11::jsonb[], $12::jsonb[], $13::jsonb[],
         $14::int[],  $15::int[],
         $16::int[],  $17::int[],  $18::int[], $19::int[]
       )
       ON CONFLICT (run_id, profile_url) DO UPDATE SET
         decision         = EXCLUDED.decision,
         decided_at_stage = EXCLUDED.decided_at_stage,
         confidence       = EXCLUDED.confidence,
         gate_result      = EXCLUDED.gate_result,
         prefilter_score  = EXCLUDED.prefilter_score,
         evidence         = EXCLUDED.evidence,
         adjudication     = EXCLUDED.adjudication,
         challenge        = EXCLUDED.challenge`,
      [
        rows.map((r) => r.runId),
        rows.map((r) => r.profileUrl),
        rows.map((r) => r.jdHash),
        rows.map((r) => r.companyName ?? null),
        rows.map((r) => r.jobName ?? null),
        rows.map((r) => r.decision),
        rows.map((r) => r.decidedAtStage),
        rows.map((r) => r.confidence),
        rows.map((r) => (r.gateResult ? JSON.stringify(r.gateResult) : null)),
        rows.map((r) => r.prefilterScore ?? null),
        rows.map((r) => (r.evidence ? JSON.stringify(r.evidence) : null)),
        rows.map((r) => (r.adjudication ? JSON.stringify(r.adjudication) : null)),
        rows.map((r) => (r.challenge ? JSON.stringify(r.challenge) : null)),
        rows.map((r) => r.quotesVerified),
        rows.map((r) => r.quotesUnverified),
        rows.map((r) => r.promptTokens),
        rows.map((r) => r.completionTokens),
        rows.map((r) => r.llmCalls),
        rows.map((r) => r.durationMs),
      ],
    );
    return res.rowCount ?? 0;
  } finally {
    client.release();
  }
}
