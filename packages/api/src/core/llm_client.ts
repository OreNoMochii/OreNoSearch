import { OpenAI } from 'openai';
import { config } from '../config';

/**
 * LLM client factory.
 *
 * Previously this module threw at import time when OPENAI_API_KEY was absent,
 * which killed the process during module resolution — before the server could
 * report a usable error. Key presence is now validated in config/index.ts,
 * which fails with a readable message listing every problem at once.
 *
 * Clients are created lazily so that importing this module has no side effects.
 */

let deepinfraClient: OpenAI | null = null;
let nvidiaClient: OpenAI | null = null;

export class MissingProviderKeyError extends Error {
  constructor(provider: string, envVar: string) {
    super(`${provider} requires ${envVar} to be set in .env`);
    this.name = 'MissingProviderKeyError';
  }
}

function getDeepinfraClient(): OpenAI {
  if (!deepinfraClient) {
    deepinfraClient = new OpenAI({
      baseURL: 'https://api.deepinfra.com/v1/openai',
      apiKey: config.OPENAI_API_KEY,
      timeout: config.LLM_TIMEOUT_MS,
      maxRetries: 3, // transient connection errors only
    });
  }
  return deepinfraClient;
}

function getNvidiaClient(): OpenAI {
  if (!config.NVIDIA_API_KEY) {
    throw new MissingProviderKeyError('NVIDIA NIM', 'NVIDIA_API_KEY');
  }
  if (!nvidiaClient) {
    nvidiaClient = new OpenAI({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: config.NVIDIA_API_KEY,
      timeout: config.LLM_TIMEOUT_MS,
      maxRetries: 0, // retries handled by ScreeningAgent's backoff loop
    });
  }
  return nvidiaClient;
}

/** Resolves the client for a model id. `nvidia:` prefix selects NVIDIA NIM. */
export function getClient(model: string): OpenAI {
  return model.startsWith('nvidia:') ? getNvidiaClient() : getDeepinfraClient();
}

/** Strips any provider prefix, yielding the id the API expects. */
export function normaliseModelId(model: string): string {
  return model.startsWith('nvidia:') ? model.slice('nvidia:'.length) : model;
}

/** @deprecated Use getClient(model). Retained for existing imports. */
export const llmClient = {
  get chat() {
    return getDeepinfraClient().chat;
  },
};
