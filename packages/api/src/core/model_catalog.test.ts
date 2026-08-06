import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG,
  findModel,
  modelsForProvider,
  estimateCost,
  challengerSharesFamily,
  needsLegacyJsonMode,
} from './model_catalog';
import { config } from '../config';

describe('model catalogue', () => {
  it('has no duplicate ids', () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every model that was previously offered in the UI', () => {
    // These four were the hardcoded <option> list. Removing one silently would
    // break a saved selection in someone's localStorage.
    for (const id of [
      'deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-R1',
      'nvidia:meta/llama-3.1-70b-instruct',
      'nvidia:meta/llama-3.1-405b-instruct',
    ]) {
      expect(findModel(id), `${id} missing from catalogue`).toBeDefined();
    }
  });

  it('offers the Gemma 3 instruct family on DeepInfra', () => {
    for (const id of ['google/gemma-3-27b-it', 'google/gemma-3-12b-it', 'google/gemma-3-4b-it']) {
      const m = findModel(id);
      expect(m, `${id} missing`).toBeDefined();
      expect(m?.provider).toBe('deepinfra');
      expect(m?.family).toBe('gemma');
    }
  });

  it('prices every DeepInfra model and no NIM model', () => {
    // NIM is credit/licence based. A per-token figure there would produce a
    // confident, wrong comparison against DeepInfra.
    for (const m of MODEL_CATALOG) {
      if (m.provider === 'deepinfra') {
        expect(m.inputPer1M, `${m.id} has no input price`).toBeTypeOf('number');
        expect(m.outputPer1M, `${m.id} has no output price`).toBeTypeOf('number');
      } else {
        expect(m.inputPer1M, `${m.id} should not be priced per token`).toBeNull();
        expect(m.outputPer1M, `${m.id} should not be priced per token`).toBeNull();
      }
    }
  });

  it('splits cleanly by provider', () => {
    const di = modelsForProvider('deepinfra');
    const nv = modelsForProvider('nvidia');
    expect(di.length).toBeGreaterThan(0);
    expect(nv.length).toBeGreaterThan(0);
    expect(di.length + nv.length).toBe(MODEL_CATALOG.length);
    expect(nv.every((m) => m.id.startsWith('nvidia:'))).toBe(true);
  });

  describe('cost estimation', () => {
    it('prices a DeepInfra call', () => {
      // Gemma 3 27B: $0.09 in / $0.17 out per 1M.
      const { usd, perTokenPricing } = estimateCost('google/gemma-3-27b-it', 1_000_000, 1_000_000);
      expect(perTokenPricing).toBe(true);
      expect(usd).toBeCloseTo(0.26, 5);
    });

    it('reports NIM as not per-token rather than free', () => {
      // 0 and "unpriced" are different claims; conflating them would make NIM
      // look free in a cost comparison.
      const { usd, perTokenPricing } = estimateCost(
        'nvidia:meta/llama-3.1-405b-instruct',
        1_000_000,
        1_000_000,
      );
      expect(perTokenPricing).toBe(false);
      expect(usd).toBeNull();
    });

    it('returns null for an unknown model', () => {
      expect(estimateCost('some/unlisted-model', 1000, 1000).usd).toBeNull();
    });
  });

  it('detects a challenger sharing the adjudicator family', () => {
    expect(
      challengerSharesFamily(
        'nvidia:meta/llama-3.3-70b-instruct',
        'nvidia:meta/llama-3.1-405b-instruct',
      ),
    ).toBe(true);
    expect(
      challengerSharesFamily(
        'nvidia:nvidia/llama-3.1-nemotron-70b-instruct',
        'nvidia:deepseek-ai/deepseek-r1',
      ),
    ).toBe(false);
  });

  it('defaults unknown models to the modern JSON path', () => {
    expect(needsLegacyJsonMode('some/unlisted-model')).toBe(false);
  });
});

describe('configured stage models', () => {
  it('every SCREENING_MODEL_* default exists in the catalogue', () => {
    // A typo here fails at the first live call, mid-campaign. Catching it in
    // the suite is considerably cheaper.
    const configured = {
      compiler: config.SCREENING_MODEL_COMPILER,
      extractor: config.SCREENING_MODEL_EXTRACTOR,
      adjudicator: config.SCREENING_MODEL_ADJUDICATOR,
      challenger: config.SCREENING_MODEL_CHALLENGER,
      escalation: config.SCREENING_MODEL_ESCALATION,
    };
    for (const [role, id] of Object.entries(configured)) {
      expect(findModel(id), `${role} model "${id}" is not in the catalogue`).toBeDefined();
    }
  });

  it('ships a challenger from a different family than the adjudicator', () => {
    expect(
      challengerSharesFamily(config.SCREENING_MODEL_ADJUDICATOR, config.SCREENING_MODEL_CHALLENGER),
    ).toBe(false);
  });
});
