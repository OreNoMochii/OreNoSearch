/**
 * config.ts — the single configuration boundary for the scraper package.
 *
 * Four modules (database.ts, sync_meili.ts, cleanup.ts,
 * backfill_latest_roles.ts) each called bare `dotenv.config()`. With no path
 * argument that resolves relative to process.cwd(), so the same script picked
 * up different values depending on the directory it was launched from — and
 * silently fell back to `undefined` when run from the repo root, since the
 * .env lives there but cwd-relative lookup only finds it by coincidence.
 *
 * This mirrors packages/api/src/config: load once, from an absolute path,
 * validate, and fail with a readable message instead of a driver error.
 */
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// The ONLY dotenv.config() call in the scraper package.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const ConfigSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().default(5433),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  MEILI_URL: z.string().url().optional(),
  MEILI_KEY: z.string().optional(),
  MEILI_INDEX: z.string().default('candidates'),

  /**
   * Guards the DDL in initDb(). Schema changes must be deliberate, never a
   * side effect of running a scrape.
   */
  ALLOW_SCHEMA_INIT: z
    .string()
    .optional()
    .transform((v) => v === '1'),
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write('\nInvalid scraper configuration:\n');
  for (const issue of parsed.error.issues) {
    process.stderr.write(`  ${issue.path.join('.') || '(root)'}: ${issue.message}\n`);
  }
  process.stderr.write('\nSee .env.example for the required keys.\n\n');
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
