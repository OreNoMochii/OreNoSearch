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
