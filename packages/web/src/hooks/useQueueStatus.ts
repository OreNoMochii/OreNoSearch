import { useEffect, useState } from 'react';

export interface QueueStatus {
  activeCount: number;
  maxConcurrent: number;
  pendingCount: number;
  activeBatches: { id: number; size: number; processed: number; owner: string }[];
  queuedBatches: { id: number; size: number; owner: string }[];
}

const ACTIVE_INTERVAL_MS = 3_000;
const IDLE_INTERVAL_MS = 20_000;

/**
 * Polls /api/queue-status.
 *
 * The previous effect in App.tsx ran a fixed 3-second setInterval for the
 * lifetime of the page — including while the tab was hidden and while nothing
 * was running — and never aborted the in-flight request on unmount, so a slow
 * response could call setState after teardown.
 *
 * This backs off to 20s when the queue is idle, skips polling entirely for a
 * background tab, and aborts cleanly.
 */
export function useQueueStatus(): QueueStatus | null {
  const [status, setStatus] = useState<QueueStatus | null>(null);

  const busy = status !== null && (status.activeCount > 0 || status.pendingCount > 0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/queue-status', {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as QueueStatus;
        if (!cancelled) setStatus(data);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.warn('Queue status poll failed', err);
        }
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), busy ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);

    // Refresh immediately when the tab is brought back to the foreground.
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [busy]);

  return status;
}
