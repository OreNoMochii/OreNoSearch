import { Activity, Clock } from 'lucide-react';
import type { QueueStatus } from '../hooks/useQueueStatus';
import styles from './QueueMonitor.module.css';

interface QueueMonitorProps {
  status: QueueStatus | null;
}

/**
 * Floating progress panel for in-flight screening batches.
 *
 * Accessibility notes:
 *  - the region is labelled and announced politely, so a screen-reader user
 *    learns that a batch finished without focus being stolen;
 *  - progress uses a real <progress> element rather than a coloured div, so
 *    the value is exposed to assistive technology;
 *  - `owner` is an email address, so it is rendered as plain text and never
 *    used to build a link.
 */
export function QueueMonitor({ status }: QueueMonitorProps) {
  if (!status || (status.activeCount === 0 && status.pendingCount === 0)) return null;

  return (
    <section className={styles.panel} aria-labelledby="queue-monitor-heading" aria-live="polite">
      <div className={styles.header}>
        <Activity size={18} aria-hidden="true" className={styles.icon} />
        <h2 id="queue-monitor-heading" className={styles.heading}>
          AI screening engine
        </h2>
      </div>

      <ul className={styles.list}>
        {status.activeBatches.map((batch) => {
          const pct = batch.size > 0 ? Math.round((batch.processed / batch.size) * 100) : 0;
          return (
            <li key={batch.id} className={styles.item}>
              <div className={styles.itemHeader}>
                <span className={styles.batchLabel}>
                  <span className={styles.dot} aria-hidden="true" />
                  Batch #{batch.id}
                </span>
                <span className={styles.count}>
                  {batch.processed} / {batch.size}
                </span>
              </div>
              <progress
                className={styles.progress}
                value={batch.processed}
                max={Math.max(batch.size, 1)}
                aria-label={`Batch ${batch.id}: ${pct}% complete`}
              />
            </li>
          );
        })}
      </ul>

      {status.pendingCount > 0 ? (
        <div className={styles.pending}>
          <Clock size={14} aria-hidden="true" />
          <span>
            {status.pendingCount} batch{status.pendingCount === 1 ? '' : 'es'} queued
          </span>
        </div>
      ) : null}
    </section>
  );
}
