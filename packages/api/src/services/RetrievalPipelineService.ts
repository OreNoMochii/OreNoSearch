import { logInfo, logWarn, logError } from '../utils/logger';
import { config } from '../config';

/**
 * RetrievalPipelineService.ts
 *
 * Thin TypeScript wrapper around the Python FastAPI retrieval microservice
 * running at http://localhost:8765.
 *
 * Features:
 *  - Health check before calling /search
 *  - 5-minute timeout for the full pipeline
 *  - Automatic fallback: if microservice is unreachable, caller gets `null`
 *    and OutreachService falls back to the standard Meilisearch path
 */

const PIPELINE_BASE = config.RETRIEVAL_SERVICE_URL;

export interface PipelineCandidate {
  profile_url: string;
  name: string;
  headline?: string;
  current_company?: string;
  location?: string;
  email?: string;
  rrf_score?: number;
  reranker_score?: number;
  audit_fit_score?: number;
  audit_seniority?: string;
  audit_evidence?: string[];
  source?: string;
}

export interface PipelineMeta {
  total_retrieved: number;
  after_rerank: number;
  passed_audit: number;
  top_n: number;
  top_k: number;
  duration_seconds: number;
  expansion_keywords: string[];
}

export interface PipelineSearchResponse {
  candidates: PipelineCandidate[];
  meta: PipelineMeta;
}

export class RetrievalPipelineService {
  /**
   * Check if the microservice is running and healthy.
   * Returns false (instead of throwing) so callers can fall back gracefully.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const resp = await fetch(`${PIPELINE_BASE}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Run the full 4-stage pipeline.
   *
   * @param jd      Full job description text
   * @param topN    Stage 2 retrieval pool size (50–500)
   * @param topK    Stage 3 reranked shortlist size (10–100)
   * @returns       Audited candidates (PASS only), or null on failure
   */
  async search(
    jd: string,
    topN: number,
    topK: number,
    companyName?: string,
    model?: string,
    minExp?: number,
    maxExp?: number,
  ): Promise<PipelineSearchResponse | null> {
    const started = Date.now();
    try {
      logInfo('pipeline_request', { topN, topK, companyName, model, minExp, maxExp });

      const resp = await fetch(`${PIPELINE_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jd,
          top_n: topN,
          top_k: topK,
          company_name: companyName,
          model,
          min_years: minExp,
          max_years: maxExp,
        }),
        // B11: the doc comment above has always promised a 5-minute
        // timeout, but no signal was ever passed. A stalled microservice
        // hung this fetch indefinitely, and because the call happens
        // inside a queued batch, the concurrency slot was never released.
        signal: AbortSignal.timeout(config.RETRIEVAL_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const body = await resp.text();
        logWarn('pipeline_error_response', {
          status: resp.status,
          body: body.slice(0, 500),
        });
        return null;
      }

      const data = (await resp.json()) as PipelineSearchResponse;

      // Guard against a shape change silently producing NaN downstream.
      if (!data?.meta || !Array.isArray(data.candidates)) {
        logWarn('pipeline_malformed_response');
        return null;
      }

      logInfo('pipeline_complete', {
        retrieved: data.meta.total_retrieved,
        reranked: data.meta.after_rerank,
        passed: data.meta.passed_audit,
        durationMs: Date.now() - started,
      });
      return data;
    } catch (err) {
      const isTimeout = (err as Error).name === 'TimeoutError';
      logError(isTimeout ? 'pipeline_timeout' : 'pipeline_unreachable', err, {
        elapsedMs: Date.now() - started,
      });
      return null;
    }
  }
}

export const retrievalPipelineService = new RetrievalPipelineService();
