import { Request, Response } from 'express';
import { logInfo, logError } from '../utils/logger';
import { OutreachRequest } from '../core/schemas';
import { BullBatchQueue, type OutreachJobData } from '../infrastructure/BullBatchQueue';
import { getRedis, isRedisAvailable } from '../infrastructure/redis';

// The Redis client attaches its own error handlers (see infrastructure/redis.ts),
// so an unreachable Redis degrades this endpoint instead of killing the process.
const bullQueue = new BullBatchQueue(getRedis());

/** Exposed so main.ts can drain the queue during graceful shutdown (B26). */
export async function shutdownQueue(): Promise<void> {
  await bullQueue.close();
}

export class OutreachController {
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

    // Fail fast and legibly rather than letting the request hang on ioredis'
    // offline queue until the client times out.
    if (!isRedisAvailable()) {
      logError('outreach_rejected_no_queue', new Error('Redis unavailable'));
      return res.status(503).json({
        error: 'Job queue is unavailable. The campaign was not accepted — please retry.',
      });
    }

    const targetModel = body.model ?? 'deepseek-ai/DeepSeek-V3.2';

    try {
      // B27: durable, atomic id from Redis rather than a process-local
      // counter that resets on restart and collides with persisted jobs.
      const batchId = await bullQueue.nextBatchId();

      logInfo('outreach_requested', {
        batchId,
        candidateCount: body.candidates.length,
        model: targetModel,
        engine: body.screeningEngine,
        pipeline: body.usePipeline,
      });

      const jobData: OutreachJobData = {
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
        queue_status:
          `Active Batches: ${snapshot.activeCount}/${snapshot.maxConcurrent}, ` +
          `Pending in Queue: ${snapshot.pendingCount}`,
      });
    } catch (err) {
      logError('outreach_enqueue_failed', err);
      return res.status(503).json({
        error: 'Could not queue the campaign. Nothing was sent — please retry.',
      });
    }
  }

  static async getQueueStatus(_req: Request, res: Response): Promise<void> {
    // Polled every few seconds by the UI: degrade to an empty snapshot
    // rather than a 500 when Redis is briefly unavailable.
    if (!isRedisAvailable()) {
      res.json({
        activeCount: 0,
        maxConcurrent: 0,
        pendingCount: 0,
        activeBatches: [],
        queuedBatches: [],
        degraded: true,
      });
      return;
    }

    try {
      const snapshot = await bullQueue.snapshot();
      res.json({ ...snapshot, degraded: false });
    } catch (err) {
      logError('queue_status_failed', err);
      res.json({
        activeCount: 0,
        maxConcurrent: 0,
        pendingCount: 0,
        activeBatches: [],
        queuedBatches: [],
        degraded: true,
      });
    }
  }
}

/** Reports progress for an in-flight batch. Advisory: never throws. */
export function recordBatchProgress(batchId: number | undefined, delta = 1): void {
  if (batchId === undefined) return;
  void bullQueue
    .reportProgress(batchId, delta)
    .catch((err) => logError('progress_report_failed', err));
}
