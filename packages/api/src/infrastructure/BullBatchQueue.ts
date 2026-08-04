import { Queue, Worker, Job } from 'bullmq';
import { RedisOptions, Redis } from 'ioredis';
import { config } from '../config';
import { BatchQueue } from '../domain/ports';
import { outreachOrchestrator } from '../services/OutreachOrchestrator';
import { logInfo, logError } from '../utils/logger';

export interface LegacyOutreachJob {
  jdText: string;
  uiCandidates: any[];
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
  screeningEngine: "llm" | "tree" | "tree_llm";
  treeTopK?: number;
  useCompanyIntel: boolean;
}

export class BullBatchQueue implements BatchQueue {
  private readonly queue: Queue<LegacyOutreachJob>;
  private readonly worker: Worker<LegacyOutreachJob>;

  constructor(connection: Redis) {
    this.queue = new Queue('outreach', { connection });
    this.worker = new Worker<LegacyOutreachJob>(
      'outreach',
      async (job: Job<LegacyOutreachJob>) => {
        logInfo('bullmq_job_started', { batchId: job.data.batchId });
        await outreachOrchestrator.run({
            jdText: job.data.jdText,
            uiCandidates: job.data.uiCandidates,
            companyName: job.data.companyName,
            jobName: job.data.jobName,
            recipients: job.data.recipients,
            cc: undefined,
            bypassDeduplication: job.data.bypassDeduplication,
            batchId: job.data.batchId,
            screening: {
                engine: job.data.screeningEngine,
                model: job.data.targetModel,
                adjacentRoles: job.data.adjacentRoles,
                topN: job.data.topN,
                topK: job.data.topK,
                treeTopK: job.data.treeTopK,
                minExp: job.data.minExp,
                maxExp: job.data.maxExp
            }
        });
      },
      { connection, concurrency: config.MAX_CONCURRENT_BATCHES }
    );

    this.worker.on('failed', (job, err) => {
      logError('bullmq_job_failed', err, { batchId: job?.data.batchId });
    });
    this.worker.on('completed', (job) => {
      logInfo('bullmq_job_completed', { batchId: job?.data.batchId });
    });
  }

  async enqueue(job: LegacyOutreachJob): Promise<number> {
    await this.queue.add('campaign', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86_400, count: 500 },
      removeOnFail: false,
    });
    return job.batchId;
  }

  async reportProgress(batchId: number, processed: number): Promise<void> {
    // BullMQ supports job progress, but we just implement the port for now.
  }

  async snapshot(): Promise<{ activeCount: number; pendingCount: number; maxConcurrent: number }> {
    const [active, waiting] = await Promise.all([
      this.queue.getActiveCount(),
      this.queue.getWaitingCount(),
    ]);
    return {
      activeCount: active,
      pendingCount: waiting,
      maxConcurrent: config.MAX_CONCURRENT_BATCHES,
    };
  }
}
