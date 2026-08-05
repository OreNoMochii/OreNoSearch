import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config';
import type { BatchQueue, CandidateSpec } from '../domain/ports';
import { outreachOrchestrator } from '../composition';
import { logInfo, logWarn, logError } from '../utils/logger';

/**
 * Payload persisted in Redis for one outreach campaign.
 *
 * `candidateSpec` replaced a `uiCandidates: CandidateInput[]` field holding up
 * to 100,000 fully-populated candidate rows. That array was posted from the
 * browser and then stored here verbatim, so every queued campaign occupied
 * hundreds of megabytes of Redis — and `removeOnComplete.count` kept 500 of
 * them. The spec is a few hundred bytes and the worker resolves it against
 * Postgres.
 */
export interface OutreachJobData {
  jdText: string;
  candidateSpec: CandidateSpec;
  /** Caller's estimate, used only as the progress denominator until the
   *  worker resolves the set and publishes the real figure. */
  candidateCount: number;
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

/** Progress state for one in-flight batch, held next to its job handle. */
interface ActiveBatch {
  job: Job<OutreachJobData>;
  processed: number;
  total: number;
  /** Set while a flush to Redis is pending, so bursts coalesce. */
  flushTimer?: NodeJS.Timeout;
}

/** Minimum gap between progress writes to Redis. */
const PROGRESS_FLUSH_MS = 1_000;

export class BullBatchQueue implements BatchQueue {
  private readonly queue: Queue<OutreachJobData>;
  private readonly worker: Worker<OutreachJobData>;
  private closing = false;

  /**
   * Job handles for batches this process is running.
   *
   * reportProgress previously called `queue.getJobs(['active'], 0, 50)` on
   * *every* candidate and linear-scanned the result — a Redis round trip
   * deserialising up to 50 job payloads per candidate processed. Holding the
   * handle the worker was already given makes it a local map lookup.
   */
  private readonly active = new Map<number, ActiveBatch>();

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

        this.active.set(job.data.batchId, {
          job,
          processed: 0,
          total: job.data.candidateCount,
        });

        try {
          await outreachOrchestrator.run({
            jdText: job.data.jdText,
            candidateSpec: job.data.candidateSpec,
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
        } finally {
          const entry = this.active.get(job.data.batchId);
          if (entry?.flushTimer) clearTimeout(entry.flushTimer);
          this.active.delete(job.data.batchId);
        }
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

  /**
   * Publishes progress so /api/queue-status reflects work in flight.
   *
   * `delta` accumulates locally and is flushed to Redis at most once per
   * PROGRESS_FLUSH_MS. The previous implementation fetched up to 50 active jobs
   * from Redis on every call and then passed the *delta* to updateProgress, so
   * a 100,000-candidate campaign made 100,000 round trips to report a value
   * that was always 1.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- BatchQueue port is async
  async reportProgress(batchId: number, delta: number): Promise<void> {
    const entry = this.active.get(batchId);
    if (!entry) return;

    entry.processed += delta;
    if (entry.flushTimer) return;

    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = undefined;
      void entry.job.updateProgress(entry.processed).catch((err: unknown) => {
        // Progress reporting is advisory: never fail a campaign over it.
        logWarn('bullmq_progress_failed', { batchId, message: (err as Error).message });
      });
    }, PROGRESS_FLUSH_MS);
    entry.flushTimer.unref();
  }

  /**
   * Records how many candidates a batch will actually process.
   *
   * With a server-resolved candidate set the enqueuing client cannot know this,
   * so the job carries only an estimate until the worker publishes the real
   * figure here.
   */
  async setBatchSize(batchId: number, total: number): Promise<void> {
    const entry = this.active.get(batchId);
    if (!entry) return;

    entry.total = total;
    try {
      await entry.job.updateData({ ...entry.job.data, candidateCount: total });
    } catch (err) {
      logWarn('bullmq_size_update_failed', { batchId, message: (err as Error).message });
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
      activeBatches: activeJobs.map((j) => {
        // Prefer this process's live counters: they are ahead of whatever was
        // last flushed to Redis, and they carry the resolved candidate total.
        const local = this.active.get(j.data.batchId);
        return {
          id: j.data.batchId,
          size: local?.total ?? j.data.candidateCount,
          processed: local?.processed ?? (typeof j.progress === 'number' ? j.progress : 0),
          owner: j.data.recipients,
        };
      }),
      queuedBatches: waitingJobs.map((j) => ({
        id: j.data.batchId,
        size: j.data.candidateCount,
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
