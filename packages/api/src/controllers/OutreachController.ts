import { Request, Response } from 'express';
import { config } from '../config';
import { logInfo, logWarn, logError } from '../utils/logger';
import { OutreachRequest } from '../core/schemas';
import { outreachService } from '../services/OutreachService';

interface BatchDetail {
    size: number;
    processed: number;
    owner: string;
    startedAt: number;
}

interface QueuedBatch {
    id: number;
    task: () => Promise<void>;
    size: number;
    owner: string;
    queuedAt: number;
}

const MAX_CONCURRENT_BATCHES = config.MAX_CONCURRENT_BATCHES;

export const activeBatchDetails: Map<number, BatchDetail> = new Map();
const batchQueue: QueuedBatch[] = [];
let activeBatches = 0;
let nextBatchId = 1;

/**
 * Drains the queue up to the concurrency limit.
 *
 * B18: the previous version invoked itself as a bare expression in both the
 * `finally` block and the request handler. Because `runNextInQueue` is async
 * and awaits the entire campaign, those were floating promises — a rejection
 * anywhere inside (including from the logger) became an unhandled rejection,
 * which terminates the process on Node 15+.
 *
 * Each task is now given its own terminal catch, and the pump is driven by a
 * synchronous loop rather than recursion.
 */
function pump(): void {
    while (activeBatches < MAX_CONCURRENT_BATCHES && batchQueue.length > 0) {
        const batch = batchQueue.shift();
        if (!batch) return;

        activeBatches++;
        activeBatchDetails.set(batch.id, {
            size: batch.size,
            processed: 0,
            owner: batch.owner,
            startedAt: Date.now(),
        });

        logInfo('batch_started', {
            batchId: batch.id,
            size: batch.size,
            active: activeBatches,
            max: MAX_CONCURRENT_BATCHES,
            queuedForMs: Date.now() - batch.queuedAt,
        });

        // Terminal catch: nothing downstream can produce an unhandled rejection.
        void batch
            .task()
            .catch((err: unknown) => logError('batch_failed', err, { batchId: batch.id }))
            .finally(() => {
                const detail = activeBatchDetails.get(batch.id);
                activeBatches--;
                activeBatchDetails.delete(batch.id);
                logInfo('batch_completed', {
                    batchId: batch.id,
                    processed: detail?.processed ?? 0,
                    durationMs: detail ? Date.now() - detail.startedAt : undefined,
                });
                pump();
            });
    }
}

export class OutreachController {
    // so Express routes stay uniform and future awaits need no signature change.
    // eslint-disable-next-line @typescript-eslint/require-await -- uniform async route signature
    static async triggerOutreach(req: Request, res: Response): Promise<Response> {
        const parsed = OutreachRequest.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Invalid outreach request',
                details: parsed.error.issues.map((i) => ({
                    field: i.path.join('.'),
                    message: i.message,
                })),
            });
        }
        const body = parsed.data;

        // The candidate list may legitimately be empty for pipeline and tree
        // engines, which source candidates themselves.
        const needsCandidates = !body.usePipeline && body.screeningEngine === 'llm';
        if (needsCandidates && body.candidates.length === 0) {
            return res.status(400).json({
                error: "The 'llm' screening engine requires a non-empty 'candidates' array",
            });
        }

        const batchId = nextBatchId++;
        const targetModel = body.model ?? 'deepseek-ai/DeepSeek-V3.2';

        logInfo('outreach_requested', {
            batchId,
            candidateCount: body.candidates.length,
            model: targetModel,
            engine: body.screeningEngine,
            pipeline: body.usePipeline,
        });

        const task = async (): Promise<void> => {
            await outreachService.runOutreachCampaign({
                jdText: body.jd,
                uiCandidates: body.candidates,
                companyName: body.companyName,
                jobName: body.jobName,
                recipients: body.email,
                targetModel,
                adjacentRoles: body.adjacentRoles ?? '',
                bypassDeduplication: body.bypassDeduplication,
                batchId,
                usePipeline: body.usePipeline,
                topN: body.topN,
                topK: body.topK,
                minExp: body.minExp,
                maxExp: body.maxExp,
                screeningEngine: body.screeningEngine,
                treeTopK: body.treeTopK,
                useCompanyIntel: body.useCompanyIntel,
            });
        };

        batchQueue.push({
            id: batchId,
            task,
            size: body.candidates.length,
            owner: body.email,
            queuedAt: Date.now(),
        });

        if (activeBatches >= MAX_CONCURRENT_BATCHES) {
            logWarn('batch_queued', { batchId, queuePosition: batchQueue.length });
        }

        pump();

        return res.status(202).json({
            message: 'Outreach batch accepted and queued for processing.',
            batch_id: batchId,
            queue_status: `Active Batches: ${activeBatches}/${MAX_CONCURRENT_BATCHES}, Pending in Queue: ${batchQueue.length}`,
        });
    }

    static getQueueStatus(_req: Request, res: Response): void {
        res.json({
            activeCount: activeBatches,
            maxConcurrent: MAX_CONCURRENT_BATCHES,
            pendingCount: batchQueue.length,
            activeBatches: Array.from(activeBatchDetails.entries()).map(([id, d]) => ({
                id,
                size: d.size,
                processed: d.processed,
                owner: d.owner,
            })),
            queuedBatches: batchQueue.map((b) => ({ id: b.id, size: b.size, owner: b.owner })),
        });
    }
}

/** Increments a batch's progress counter if it is still active. */
export function recordBatchProgress(batchId: number | undefined, delta = 1): void {
    if (batchId === undefined) return;
    const detail = activeBatchDetails.get(batchId);
    if (detail) detail.processed += delta;
}
