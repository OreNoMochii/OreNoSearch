/**
 * llm.ts — the single call path for agentic screening stages.
 *
 * Every stage goes through `callStage`, which guarantees the things the old
 * agent left to chance:
 *
 *   - temperature 0 and a fixed seed, so a verdict does not depend on sampling
 *   - schema validation at the boundary, not field access on an `any`
 *   - retries only for errors a retry could fix
 *   - token accounting, so a precision gain can be priced
 *
 * Model choice is per ROLE, not per pipeline: extraction is easy and should run
 * somewhere cheap, adjudication is the judgement call, and the challenger runs
 * on a DIFFERENT model family on purpose — a challenger that shares the
 * adjudicator's blind spots cannot catch the adjudicator's mistakes.
 */
import { z } from 'zod';
import { getClient, normaliseModelId } from '../core/llm_client';
import { config } from '../config';
import { logWarn } from '../utils/logger';
import { MinGapRateLimiter } from '../utils/rate_limiter';

/** Fixed across the pipeline. Screening the same input twice must not vary. */
export const SCREENING_SEED = 42;

export type StageRole = 'compiler' | 'extractor' | 'adjudicator' | 'challenger' | 'escalation';

/** Resolves the configured model for a stage role. */
export function modelFor(role: StageRole): string {
  switch (role) {
    case 'compiler':
      return config.SCREENING_MODEL_COMPILER;
    case 'extractor':
      return config.SCREENING_MODEL_EXTRACTOR;
    case 'adjudicator':
      return config.SCREENING_MODEL_ADJUDICATOR;
    case 'challenger':
      return config.SCREENING_MODEL_CHALLENGER;
    case 'escalation':
      return config.SCREENING_MODEL_ESCALATION;
  }
}

// NVIDIA NIM's limits are per-account, so one limiter is shared by every stage
// rather than one per role — otherwise five stages would each think they had a
// full budget and the account would be throttled.
const nvidiaLimiter = new MinGapRateLimiter(config.NVIDIA_MIN_GAP_MS);
const defaultLimiter = new MinGapRateLimiter(100);

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export const emptyUsage = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  calls: 0,
});

export function addUsage(into: TokenUsage, from: TokenUsage): void {
  into.promptTokens += from.promptTokens;
  into.completionTokens += from.completionTokens;
  into.calls += from.calls;
}

export interface StageCallOptions<T> {
  role: StageRole;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Overrides the configured model — used by escalation. */
  modelOverride?: string;
  maxTokens?: number;
  /**
   * Sampling temperature. Defaults to 0.
   *
   * The only legitimate reason to raise it is self-consistency sampling, where
   * identical outputs would defeat the purpose of taking several samples.
   */
  temperature?: number;
  /** Varies the seed for self-consistency samples. */
  seedOffset?: number;
}

export interface StageResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  usage: TokenUsage;
}

/** Strips reasoning tags and code fences, then isolates the JSON object. */
export function extractJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
  s = s.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');
  s = s.trim();

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  return s;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_SECONDS = [4, 10, 20];

/**
 * Runs one stage call and validates the result against its schema.
 *
 * Returns a result object rather than throwing: a stage failing is an expected
 * condition the pipeline handles by abstaining, not an exception that should
 * abort a whole campaign.
 */
export async function callStage<T>(opts: StageCallOptions<T>): Promise<StageResult<T>> {
  const model = opts.modelOverride ?? modelFor(opts.role);
  const isNvidia = model.startsWith('nvidia:');
  const client = getClient(model);
  const limiter = isNvidia ? nvidiaLimiter : defaultLimiter;
  const usage = emptyUsage();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await limiter.acquire();

      const completion = await client.chat.completions.create({
        model: normaliseModelId(model),
        temperature: opts.temperature ?? 0,
        top_p: 1,
        seed: SCREENING_SEED + (opts.seedOffset ?? 0),
        max_tokens: opts.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        // Asked for rather than relied upon: not every NIM model honours it,
        // which is why extractJson exists as well.
        response_format: { type: 'json_object' },
      });

      usage.calls += 1;
      usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
      usage.completionTokens += completion.usage?.completion_tokens ?? 0;

      const content = completion.choices[0]?.message?.content ?? '';
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJson(content));
      } catch {
        // Malformed JSON is worth one more sample; a different decode of the
        // same prompt often succeeds.
        if (attempt < MAX_ATTEMPTS) continue;
        return { ok: false, error: 'model did not return parseable JSON', usage };
      }

      const validated = opts.schema.safeParse(parsedJson);
      if (!validated.success) {
        const detail = validated.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        // A schema violation is deterministic for this prompt — retrying the
        // identical request cannot fix it, so fail fast rather than burning
        // the backoff budget the old agent wasted on exactly this case.
        logWarn('stage_schema_violation', { role: opts.role, model, detail });
        return { ok: false, error: `schema violation: ${detail}`, usage };
      }

      return { ok: true, data: validated.data, usage };
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string };
      const status = err.status;
      const message = err.message ?? String(error);
      const retryable =
        status === 429 || status === 408 || status === undefined || (status ?? 0) >= 500;

      if (!retryable || attempt === MAX_ATTEMPTS) {
        logWarn('stage_call_failed', { role: opts.role, model, status, message });
        return { ok: false, error: message, usage };
      }

      const waitMs = (BACKOFF_SECONDS[attempt - 1] ?? 20) * 1000 + Math.random() * 2000;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return { ok: false, error: 'exhausted attempts', usage };
}
