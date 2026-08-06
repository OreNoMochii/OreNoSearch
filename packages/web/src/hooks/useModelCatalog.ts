import { useEffect, useState } from 'react';

export interface CatalogModel {
  id: string;
  provider: 'deepinfra' | 'nvidia';
  label: string;
  family: string;
  /** USD per 1M tokens. null where the provider is not billed per token. */
  inputPer1M: number | null;
  outputPer1M: number | null;
  contextTokens?: number;
  goodFor: string[];
  reasoning: boolean;
  notes?: string;
}

/**
 * The model list, served by the API.
 *
 * Previously the picker was a hardcoded <option> list in App.tsx, which could
 * drift from the ids the backend actually routes. One list, served once.
 *
 * The fallback below exists so the picker is never empty if /api/models fails —
 * a campaign should not be blocked by a cosmetic fetch. It deliberately holds
 * only the two long-standing defaults rather than a stale copy of the catalogue.
 */
const FALLBACK: CatalogModel[] = [
  {
    id: 'deepseek-ai/DeepSeek-V3.2',
    provider: 'deepinfra',
    label: 'DeepSeek V3.2',
    family: 'deepseek',
    inputPer1M: null,
    outputPer1M: null,
    goodFor: [],
    reasoning: false,
  },
  {
    id: 'nvidia:meta/llama-3.1-70b-instruct',
    provider: 'nvidia',
    label: 'NIM · Llama 3.1 70B',
    family: 'llama',
    inputPer1M: null,
    outputPer1M: null,
    goodFor: [],
    reasoning: false,
  },
];

export interface ModelCatalog {
  models: CatalogModel[];
  pricesVerifiedOn: string | null;
  loaded: boolean;
}

export function useModelCatalog(): ModelCatalog {
  const [catalog, setCatalog] = useState<ModelCatalog>({
    models: FALLBACK,
    pricesVerifiedOn: null,
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetch('/api/models', { credentials: 'include', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { models: CatalogModel[]; pricesVerifiedOn: string }) => {
        if (cancelled || !Array.isArray(data.models) || data.models.length === 0) return;
        setCatalog({
          models: data.models,
          pricesVerifiedOn: data.pricesVerifiedOn ?? null,
          loaded: true,
        });
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') {
          console.warn('Model catalogue unavailable, using fallback', err);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return catalog;
}

/** "$0.27 / $0.41 per 1M" — or a note that the provider is not per-token. */
export function formatCost(model: CatalogModel): string {
  if (model.inputPer1M === null || model.outputPer1M === null) {
    return 'NIM credits · not per-token';
  }
  return `$${model.inputPer1M.toFixed(2)} in / $${model.outputPer1M.toFixed(2)} out per 1M`;
}
