import type { ProgressReporter } from '../domain/ports';
import { recordBatchProgress, recordBatchSize } from '../controllers/OutreachController';

/**
 * Reports batch progress to the BullMQ job.
 *
 * This is the one place permitted to know about the controller. Adapters
 * depend on the ProgressReporter port instead, so the dependency now points
 * inward (infrastructure -> domain) rather than infrastructure -> HTTP.
 */
export class QueueProgressReporter implements ProgressReporter {
  report(batchId: number | undefined, delta = 1): void {
    recordBatchProgress(batchId, delta);
  }

  setTotal(batchId: number | undefined, total: number): void {
    recordBatchSize(batchId, total);
  }
}
