import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config';
import type { BatchQueue } from '../domain/ports';
import type { CandidateInput } from '../core/schemas';
import { outreachOrchestrator } from '../services/OutreachOrchestrator';
import { logInfo, logWarn, logError } from '../utils/logger';

/** Payload persisted in Redis for one outreach campaign. */
export interface OutreachJobData {
  jdText: string;
  uiCandidates: CandidateInput[];
  companyName: string;
  jobName: string;
  recipients: string;
  targetModel: string;
  adjacentRoles: string;
  bypassDeduplication: boolean;
  batchId: number;
  usePipeline: boolean;
  topN?: number;
  topK?: number;
  minExp?: number;
  maxExp?: number;
  screeningEngine: 'llm' | 'tree' | 'tree_llm';
  treeTopK?: number;
  useCompanyIntel: boolean;
}

/** Redis key holding the monotonic batch counter (B27). */
const BATCH_ID_KEY = 'metaview:batch-id';

export class BullBatchQueue implements BatchQueue {
  private readonly queue: Queue<OutreachJobData>;
  private readonly worker: Worker<OutreachJobData>;
  private closing = false;

  constructor(private readonly connection: Redis) {
    this.queue = new Queue('outreach', { connection });

    this.worker = new Worker<OutreachJobData>(
      'outreach',
      async (job: Job<OutreachJobData>) => {
        logInfo('bullmq_job_started', {
          batchId: job.data.batchId,
          attempt: job.attemptsMade + 1,
        });

        // B29: usePipeline was carried through the whole payload but
        // never mapped onto the engine, so `PipelineScreeningAdapter`
        // was unreachable and the UI's Advanced Pipeline toggle was a
        // no-op — campaigns silently ran the standard LLM path instead.
        const engine = job.data.usePipeline ? 'pipeline' : job.data.screeningEngine;

        await outreachOrchestrator.run({
          jdText: job.data.jdText,
          uiCandidates: job.data.uiCandidates,
          companyName: job.data.companyName,
          jobName: job.data.jobName,
          recipients: job.data.recipients,
          cc: undefined,
          bypassDeduplication: job.data.bypassDeduplication,
          batchId: job.data.batchId,
          useCompanyIntel: job.data.useCompanyIntel,
          screening: {
            engine,
            model: job.data.targetModel,
            adjacentRoles: job.data.adjacentRoles,
            topN: job.data.topN,
            topK: job.data.topK,
            treeTopK: job.data.treeTopK,
            minExp: job.data.minExp,
            maxExp: job.data.maxExp,
          },
        });
      },
      { connection, concurrency: config.MAX_CONCURRENT_BATCHES },
    );

    this.worker.on('failed', (job, err) => {
      logError('bullmq_job_failed', err, {
        batchId: job?.data.batchId,
        attempt: job?.attemptsMade,
        willRetry: job ? job.attemptsMade < (job.opts.attempts ?? 1) : false,
      });
    });

    this.worker.on('completed', (job) => {
      logInfo('bullmq_job_completed', { batchId: job.data.batchId });
    });

    // Without this the worker's own connection errors surface as unhandled
    // events, which is the same process-killing failure mode as B25.
    this.worker.on('error', (err) => logError('bullmq_worker_error', err));
    this.queue.on('error', (err) => logError('bullmq_queue_error', err));
  }

  /**
   * Allocates a globally unique batch id.
   *
   * B27: the previous `let nextBatchId = 1` lived in process memory while the
   * queue itself is durable in Redis. After a restart the counter reset to 1
   * and collided with jobs still persisted from the previous run, so progress
   * updates and log lines attached to the wrong campaign. INCR is atomic and
   * survives restarts, and is shared correctly across replicas.
   */
  async nextBatchId(): Promise<number> {
    return this.connection.incr(BATCH_ID_KEY);
  }

  async enqueue(job: OutreachJobData): Promise<number> {
    await this.queue.add('campaign', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86_400, count: 500 },
      // Failures are retained for inspection; a campaign that never ran is
      // something an operator needs to see.
      removeOnFail: false,
    });
    return job.batchId;
  }

  /** Publishes progress so /api/queue-status reflects work in flight. */
  async reportProgress(batchId: number, processed: number): Promise<void> {
    try {
      const jobs = await this.queue.getJobs(['active'], 0, 50);
      const job = jobs.find((j) => j.data.batchId === batchId);
      await job?.updateProgress(processed);
    } catch (err) {
      // Progress reporting is advisory: never fail a campaign over it.
      logWarn('bullmq_progress_failed', {
        batchId,
        message: (err as Error).message,
      });
    }
  }

  async snapshot(): Promise<{
    activeCount: number;
    pendingCount: number;
    maxConcurrent: number;
    activeBatches: { id: number; size: number; processed: number; owner: string }[];
    queuedBatches: { id: number; size: number; owner: string }[];
  }> {
    const [active, waiting, activeJobs, waitingJobs] = await Promise.all([
      this.queue.getActiveCount(),
      this.queue.getWaitingCount(),
      this.queue.getJobs(['active'], 0, 20),
      this.queue.getJobs(['waiting'], 0, 20),
    ]);

    return {
      activeCount: active,
      pendingCount: waiting,
      maxConcurrent: config.MAX_CONCURRENT_BATCHES,
      activeBatches: activeJobs.map((j) => ({
        id: j.data.batchId,
        size: j.data.uiCandidates.length,
        processed: typeof j.progress === 'number' ? j.progress : 0,
        owner: j.data.recipients,
      })),
      queuedBatches: waitingJobs.map((j) => ({
        id: j.data.batchId,
        size: j.data.uiCandidates.length,
        owner: j.data.recipients,
      })),
    };
  }

  /**
   * B26: stops accepting work and lets in-flight jobs finish.
   *
   * Without this, SIGTERM killed the worker mid-campaign — after candidates
   * had been written to Sheets and screening_results but before outreach
   * history was recorded, so the next run would re-process and re-send them.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    logInfo('bullmq_closing');
    // Worker first: stop pulling new jobs before tearing down the queue.
    await this.worker.close();
    await this.queue.close();
    logInfo('bullmq_closed');
  }
}
