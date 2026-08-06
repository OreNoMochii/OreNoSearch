/**
 * config/index.ts — the single configuration boundary for the backend.
 *
 * Previously six modules each called `dotenv.config()` with three different
 * relative paths, so load order determined behaviour and a missing variable
 * surfaced as an undefined at first use (or, in llm_client.ts, as a throw at
 * import time that killed the process before the server could report why).
 *
 * Here the environment is parsed and validated exactly once. Anything invalid
 * fails the process at startup with a readable list of problems.
 */
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// The ONLY dotenv.config() call in the backend.
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

/** Comma-separated string -> trimmed, non-empty array. */
const csv = () =>
  z.string().transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );

const ConfigSchema = z
  .object({
    // ── Runtime ────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    MAX_BODY_SIZE: z.string().default('10mb'),
    // zod v4: .default() on a piped transform takes the OUTPUT type.
    ALLOWED_ORIGINS: csv().default(['https://localhost:5173', 'http://localhost:5173']),

    // ── Golden database ────────────────────────────────────────────────
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().default(5433),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    /**
     * Per-connection work_mem.
     *
     * The server default of 4MB is too small for this workload: a broad search
     * builds a bitmap over millions of candidate rows, overflows work_mem and
     * degrades to a LOSSY bitmap. Postgres then rechecks every tuple on those
     * pages, re-running the plpgsql experience function per row.
     *
     * Measured: 9,390ms at 4MB -> 4,483ms at 64MB on the same query. 256MB
     * gave no further improvement, so 64MB is the knee.
     *
     * Set per-connection rather than server-wide so it applies only to this
     * application's pool.
     */
    DB_WORK_MEM: z.string().default('64MB'),
    /** Upper bound on the reported match count. See runIlikeSearch. */
    SEARCH_COUNT_CAP: z.coerce.number().int().min(100).max(100_000).default(2_000),

    // ── Meilisearch ────────────────────────────────────────────────────
    MEILI_URL: z.string().url(),
    MEILI_KEY: z.string().min(1),
    MEILI_INDEX: z.string().default('candidates'),

    // ── LLM providers ──────────────────────────────────────────────────
    OPENAI_API_KEY: z.string().min(1),
    NVIDIA_API_KEY: z.string().min(1).optional(),
    LLM_TIMEOUT_MS: z.coerce.number().int().default(300_000),

    // ── Downstream services (were hardcoded localhost literals) ────────
    RETRIEVAL_SERVICE_URL: z.string().url().default('http://localhost:8765'),
    ML_SCORING_URL: z.string().url().default('http://localhost:8000'),
    REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
    RETRIEVAL_TIMEOUT_MS: z.coerce.number().int().default(300_000),
    PYTHON_TIMEOUT_MS: z.coerce.number().int().default(900_000),

    // ── Google APIs ────────────────────────────────────────────────────
    GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
    GDRIVE_ROOT_FOLDER_ID: z.string().min(1).default('1DUr5MMZ-HpglgB0EgTqHE54mEK9B-fxC'),
    GMAIL_ADDRESS: z.string().email(),
    SENDER_NAME: z.string().default('Recruiting'),

    // ── Outreach behaviour ─────────────────────────────────────────────
    OUTREACH_BLOCKED_RECIPIENTS: csv().default([]),
    MAX_CONCURRENT_BATCHES: z.coerce.number().int().min(1).max(20).default(3),
    /**
     * Hard bound on how many candidates one campaign may screen.
     *
     * Applied server-side when the candidate set is resolved, so a caller
     * cannot widen it. The UI used to supply its own `limit: 100000` and post
     * the resulting rows back; the bound now lives on the machine that pays
     * for it.
     */
    MAX_CAMPAIGN_CANDIDATES: z.coerce.number().int().min(1).max(1_000_000).default(100_000),

    // ── Agentic screening ──────────────────────────────────────────────
    /**
     * Model per stage role, not one model for everything.
     *
     * Extraction is a easy task and should run somewhere cheap; adjudication is
     * the actual judgement. CHALLENGER should be a DIFFERENT MODEL FAMILY from
     * ADJUDICATOR — its whole job is to catch what the adjudicator missed, and
     * a model with the same training and the same blind spots will agree with
     * it for the same wrong reasons.
     *
     * Ids are provider-prefixed (`nvidia:` selects NIM). Confirm they exist in
     * your NIM catalogue — it changes.
     */
    SCREENING_MODEL_COMPILER: z.string().default('nvidia:meta/llama-3.3-70b-instruct'),
    SCREENING_MODEL_EXTRACTOR: z.string().default('nvidia:meta/llama-3.3-70b-instruct'),
    SCREENING_MODEL_ADJUDICATOR: z
      .string()
      .default('nvidia:nvidia/llama-3.1-nemotron-70b-instruct'),
    SCREENING_MODEL_CHALLENGER: z.string().default('nvidia:deepseek-ai/deepseek-r1'),
    SCREENING_MODEL_ESCALATION: z.string().default('nvidia:meta/llama-3.1-405b-instruct'),

    /** Minimum gap between NIM calls. The free tier allows roughly 40/min. */
    NVIDIA_MIN_GAP_MS: z.coerce.number().int().min(0).default(1_500),

    /**
     * Weighted competency score, 0-1, at or above which a candidate may PASS.
     * Below SCREENING_UNCERTAIN_BAND of this, they are rejected outright;
     * within the band they are returned as UNCERTAIN for review.
     */
    SCREENING_PASS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    SCREENING_UNCERTAIN_BAND: z.coerce.number().min(0).max(0.5).default(0.12),
    /** Extra samples taken when a score lands inside the uncertain band. */
    SCREENING_CONSISTENCY_SAMPLES: z.coerce.number().int().min(1).max(5).default(3),
    /** Candidates surviving the cheap stages that go on to the LLM stages. */
    SCREENING_PREFILTER_KEEP: z.coerce.number().int().min(1).max(2000).default(150),
    /**
     * Refuse to screen against a rubric no human has approved.
     *
     * Off by default so the pipeline is usable immediately; turning it on is
     * what makes the human-in-the-loop step real.
     */
    SCREENING_REQUIRE_APPROVED_RUBRIC: z.coerce.boolean().default(false),

    // ── API auth ───────────────────────────────────────────────────────
    API_USER: z.string().min(3),
    API_PASS: z.string().min(8, 'API_PASS must be at least 8 characters'),
  })
  .superRefine((cfg, ctx) => {
    // Fail closed on the credentials that shipped as defaults in source.
    const weak = new Set(['pass123', 'password', 'admin', 'changeme', 'secret']);
    if (weak.has(cfg.API_PASS.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_PASS'],
        message: 'API_PASS is a well-known default — choose a different value',
      });
    }
    if (cfg.NODE_ENV === 'production') {
      if (cfg.ALLOWED_ORIGINS.some((o) => o.includes('localhost'))) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOWED_ORIGINS'],
          message: 'localhost origins are not permitted when NODE_ENV=production',
        });
      }
      if (cfg.API_PASS.length < 16) {
        ctx.addIssue({
          code: 'custom',
          path: ['API_PASS'],
          message: 'API_PASS must be at least 16 characters when NODE_ENV=production',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

function load(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    // Written to stderr directly: the logger itself depends on this module,
    // so it is not available yet at this point in startup.
    process.stderr.write('\nInvalid configuration — the server cannot start:\n');
    for (const issue of parsed.error.issues) {
      process.stderr.write(`  ${issue.path.join('.') || '(root)'}: ${issue.message}\n`);
    }
    process.stderr.write('\nSee .env.example for the full list of required keys.\n\n');
    process.exit(1);
  }
  return parsed.data;
}

export const config: Readonly<AppConfig> = Object.freeze(load());

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
