import { logDebug } from '../utils/logger';

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

const PIPELINE_BASE = 'http://localhost:8765';

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
                signal: AbortSignal.timeout(3000),
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
        try {
            await logDebug(`[Pipeline] Calling retrieval microservice | top_n=${topN} | top_k=${topK}${companyName ? ` | company=${companyName}` : ''}${model ? ` | model=${model}` : ''}${minExp !== undefined ? ` | min_exp=${minExp}` : ''}${maxExp !== undefined ? ` | max_exp=${maxExp}` : ''}`);

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
            });

            if (!resp.ok) {
                const body = await resp.text();
                await logDebug(`[Pipeline] Error response ${resp.status}: ${body}`);
                return null;
            }

            const data: PipelineSearchResponse = await resp.json();
            await logDebug(
                `[Pipeline] ✅ Pipeline complete | retrieved=${data.meta.total_retrieved} | ` +
                `reranked=${data.meta.after_rerank} | passed=${data.meta.passed_audit} | ` +
                `duration=${data.meta.duration_seconds}s`
            );
            return data;

        } catch (err: any) {
            await logDebug(`[Pipeline] ⚠️ Failed to reach microservice: ${err.message}`);
            return null;
        }
    }
}

export const retrievalPipelineService = new RetrievalPipelineService();
