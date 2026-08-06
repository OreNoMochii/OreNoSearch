/**
 * model_catalog.ts — every model the screening engines may use, in one place.
 *
 * Model choice used to be spread across three places that could disagree: a
 * hardcoded `<option>` list in App.tsx, substring matches in ScreeningAgent
 * (`model.includes('stepfun')`), and the SCREENING_MODEL_* config defaults.
 * Adding a model meant editing all three and remembering the quirks. This is
 * the single list; the UI renders from it, the config validates against it, and
 * cost reporting reads its prices.
 *
 * ── ON THE PRICES ───────────────────────────────────────────────────────────
 *
 * DeepInfra publishes per-token pricing and CHANGES IT — often downward, and
 * without notice. The figures below are the best I have as of the date in
 * PRICES_VERIFIED_ON and should be treated as estimates for relative
 * comparison, not as billing truth. Confirm against
 * https://deepinfra.com/pricing before making a cost argument to anyone.
 *
 * NVIDIA NIM is deliberately priced as `null`. It is not a per-token product in
 * the same sense: integrate.api.nvidia.com runs on credits on the developer
 * tier, and production use is NVIDIA AI Enterprise licensing charged per GPU.
 * Inventing a $/token figure for it would produce a confident, wrong comparison
 * against DeepInfra, so the catalog reports "not per-token" instead.
 */

export type Provider = 'deepinfra' | 'nvidia';

/** Stage roles from the agentic pipeline. See screening/llm.ts. */
export type StageRole = 'compiler' | 'extractor' | 'adjudicator' | 'challenger' | 'escalation';

export interface ModelEntry {
  /** Provider-prefixed id, exactly as passed to getClient(). */
  readonly id: string;
  readonly provider: Provider;
  /** Shown in the UI. */
  readonly label: string;
  /**
   * Training lineage. The challenger must not share a family with the
   * adjudicator — a model with the same lineage has the same blind spots, and
   * two models failing identically looks exactly like one being right.
   */
  readonly family: 'llama' | 'deepseek' | 'gemma' | 'nemotron' | 'qwen' | 'mixtral' | 'other';
  /** USD per 1M input tokens. null where the provider is not per-token. */
  readonly inputPer1M: number | null;
  /** USD per 1M output tokens. null where the provider is not per-token. */
  readonly outputPer1M: number | null;
  readonly contextTokens?: number;
  /** Stage roles this is a sensible pick for. Guidance, not enforcement. */
  readonly goodFor: readonly StageRole[];
  /**
   * True for models that reject an OpenAI-style `response_format`. These get
   * the plain-prompt JSON path instead — the behaviour ScreeningAgent used to
   * express as `model.includes('stepfun') || model.includes('glm') || …`.
   */
  readonly legacyJsonMode?: boolean;
  /** Models that need a large token budget and a reasoning-effort hint. */
  readonly reasoning?: boolean;
  readonly notes?: string;
}

/** When the DeepInfra figures below were last checked. Update with them. */
export const PRICES_VERIFIED_ON = '2026-08-06';

export const MODEL_CATALOG: readonly ModelEntry[] = [
  // ── DeepInfra ─────────────────────────────────────────────────────────────
  {
    id: 'deepseek-ai/DeepSeek-V3.2',
    provider: 'deepinfra',
    label: 'DeepSeek V3.2',
    family: 'deepseek',
    inputPer1M: 0.27,
    outputPer1M: 0.41,
    contextTokens: 164_000,
    goodFor: ['compiler', 'extractor', 'adjudicator'],
    notes: 'Current default for the legacy single-call engine.',
  },
  {
    id: 'deepseek-ai/DeepSeek-R1',
    provider: 'deepinfra',
    label: 'DeepSeek R1',
    family: 'deepseek',
    inputPer1M: 0.7,
    outputPer1M: 2.4,
    contextTokens: 164_000,
    reasoning: true,
    goodFor: ['adjudicator', 'challenger', 'escalation'],
    notes: 'Reasoning model — slow and priced accordingly. Strong challenger.',
  },
  {
    id: 'google/gemma-3-27b-it',
    provider: 'deepinfra',
    label: 'Gemma 3 27B',
    family: 'gemma',
    inputPer1M: 0.09,
    outputPer1M: 0.17,
    contextTokens: 128_000,
    goodFor: ['compiler', 'extractor', 'adjudicator', 'challenger'],
    notes: 'Roughly a third the price of DeepSeek V3.2 in, half out.',
  },
  {
    id: 'google/gemma-3-12b-it',
    provider: 'deepinfra',
    label: 'Gemma 3 12B',
    family: 'gemma',
    inputPer1M: 0.05,
    outputPer1M: 0.1,
    contextTokens: 128_000,
    goodFor: ['extractor'],
  },
  {
    id: 'google/gemma-3-4b-it',
    provider: 'deepinfra',
    label: 'Gemma 3 4B',
    family: 'gemma',
    inputPer1M: 0.02,
    outputPer1M: 0.04,
    contextTokens: 128_000,
    goodFor: ['extractor'],
    notes: 'Extraction only — too small to adjudicate.',
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    provider: 'deepinfra',
    label: 'Llama 3.3 70B',
    family: 'llama',
    inputPer1M: 0.23,
    outputPer1M: 0.4,
    contextTokens: 128_000,
    goodFor: ['compiler', 'extractor', 'adjudicator'],
  },
  {
    id: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    provider: 'deepinfra',
    label: 'Llama 3.1 8B',
    family: 'llama',
    inputPer1M: 0.03,
    outputPer1M: 0.05,
    contextTokens: 128_000,
    goodFor: ['extractor'],
  },
  {
    id: 'Qwen/Qwen2.5-72B-Instruct',
    provider: 'deepinfra',
    label: 'Qwen 2.5 72B',
    family: 'qwen',
    inputPer1M: 0.13,
    outputPer1M: 0.4,
    contextTokens: 32_000,
    goodFor: ['adjudicator', 'challenger'],
    notes: 'Different lineage from Llama and DeepSeek — useful as a challenger.',
  },
  {
    id: 'openai/gpt-oss-120b',
    provider: 'deepinfra',
    label: 'GPT-OSS 120B',
    family: 'other',
    inputPer1M: 0.09,
    outputPer1M: 0.45,
    contextTokens: 128_000,
    reasoning: true,
    goodFor: ['adjudicator', 'challenger', 'escalation'],
    notes: 'Needs a 16k output budget; ScreeningAgent already special-cases it.',
  },

  // ── NVIDIA NIM ────────────────────────────────────────────────────────────
  // Not per-token: developer tier is credit-based, production is AI Enterprise
  // licensing per GPU. Cost columns are intentionally null.
  {
    id: 'nvidia:meta/llama-3.1-70b-instruct',
    provider: 'nvidia',
    label: 'NIM · Llama 3.1 70B',
    family: 'llama',
    inputPer1M: null,
    outputPer1M: null,
    contextTokens: 128_000,
    goodFor: ['compiler', 'extractor', 'adjudicator'],
  },
  {
    id: 'nvidia:meta/llama-3.1-405b-instruct',
    provider: 'nvidia',
    label: 'NIM · Llama 3.1 405B',
    family: 'llama',
    inputPer1M: null,
    outputPer1M: null,
    contextTokens: 128_000,
    goodFor: ['adjudicator', 'escalation'],
  },
  {
    id: 'nvidia:meta/llama-3.3-70b-instruct',
    provider: 'nvidia',
    label: 'NIM · Llama 3.3 70B',
    family: 'llama',
    inputPer1M: null,
    outputPer1M: null,
    contextTokens: 128_000,
    goodFor: ['compiler', 'extractor', 'adjudicator'],
  },
  {
    id: 'nvidia:nvidia/llama-3.1-nemotron-70b-instruct',
    provider: 'nvidia',
    label: 'NIM · Nemotron 70B',
    family: 'nemotron',
    inputPer1M: null,
    outputPer1M: null,
    contextTokens: 128_000,
    goodFor: ['adjudicator'],
    notes: 'Reasoning-tuned. Default adjudicator.',
  },
  {
    id: 'nvidia:deepseek-ai/deepseek-r1',
    provider: 'nvidia',
    label: 'NIM · DeepSeek R1',
    family: 'deepseek',
    inputPer1M: null,
    outputPer1M: null,
    contextTokens: 128_000,
    reasoning: true,
    goodFor: ['challenger', 'escalation'],
    notes: 'Default challenger — different family from the Nemotron adjudicator.',
  },
] as const;

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

export function findModel(id: string): ModelEntry | undefined {
  return BY_ID.get(id);
}

export function modelsForProvider(provider: Provider): readonly ModelEntry[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

/**
 * Whether a model needs the plain-prompt JSON path.
 *
 * Unknown ids default to the modern path: a model absent from the catalog is
 * more likely to be new than ancient, and the JSON extraction in
 * screening/llm.ts recovers either way.
 */
export function needsLegacyJsonMode(id: string): boolean {
  return findModel(id)?.legacyJsonMode ?? false;
}

export interface CostEstimate {
  /** USD. null where the provider is not billed per token. */
  usd: number | null;
  perTokenPricing: boolean;
}

/** Estimates spend for a call. Returns null cost for NIM, by design. */
export function estimateCost(
  id: string,
  promptTokens: number,
  completionTokens: number,
): CostEstimate {
  const model = findModel(id);
  if (!model || model.inputPer1M === null || model.outputPer1M === null) {
    return { usd: null, perTokenPricing: false };
  }
  const usd =
    (promptTokens / 1_000_000) * model.inputPer1M +
    (completionTokens / 1_000_000) * model.outputPer1M;
  return { usd, perTokenPricing: true };
}

/**
 * Flags a challenger that shares a family with the adjudicator.
 *
 * Not an error — the pipeline still runs — but it silently removes most of the
 * challenger's value, so it is worth surfacing rather than discovering later
 * from a suspiciously high agreement rate.
 */
export function challengerSharesFamily(adjudicatorId: string, challengerId: string): boolean {
  const a = findModel(adjudicatorId);
  const c = findModel(challengerId);
  if (!a || !c) return false;
  return a.family === c.family;
}
