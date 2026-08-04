import { Request, Response } from 'express';
import { config } from '../config';
import { logInfo, logWarn, logError } from '../utils/logger';
import { OutreachRequest } from '../core/schemas';

import { BullBatchQueue } from '../infrastructure/BullBatchQueue';
import Redis from 'ioredis';

const redisConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const bullQueue = new BullBatchQueue(redisConnection);

const MAX_CONCURRENT_BATCHES = config.MAX_CONCURRENT_BATCHES;
let nextBatchId = 1;

// The pump() function and floating promises were removed in favour of BullMQ workers.

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

        const jobData = {
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
        };

        await bullQueue.enqueue(jobData);

        const snapshot = await bullQueue.snapshot();

        return res.status(202).json({
            message: 'Outreach batch accepted and queued for processing.',
            batch_id: batchId,
            queue_status: `Active Batches: ${snapshot.activeCount}/${snapshot.maxConcurrent}, Pending in Queue: ${snapshot.pendingCount}`,
        });
    }

    static async getQueueStatus(_req: Request, res: Response): Promise<void> {
        const snapshot = await bullQueue.snapshot();
        res.json({
            activeCount: snapshot.activeCount,
            maxConcurrent: snapshot.maxConcurrent,
            pendingCount: snapshot.pendingCount,
        });
    }
}

/** Increments a batch's progress counter if it is still active. */
export function recordBatchProgress(batchId: number | undefined, delta = 1): void {
    if (batchId === undefined) return;
    bullQueue.reportProgress(batchId, delta).catch((err) => logError('progress_report_failed', err));
}
