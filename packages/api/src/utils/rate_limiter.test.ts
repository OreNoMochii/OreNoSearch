import { describe, it, expect } from 'vitest';
import { MinGapRateLimiter } from './rate_limiter';

describe('MinGapRateLimiter', () => {
  describe('B6 — concurrent acquisition race', () => {
    /**
     * The original implementation read and wrote _lastRequestTime either
     * side of an await, so every member of a concurrent wave observed the
     * same timestamp, computed the same delay and fired simultaneously —
     * the limiter enforced nothing.
     *
     * This is the regression test for that: N simultaneous acquisitions
     * must be spaced, not batched.
     */
    it('spaces concurrent acquirers instead of releasing them together', async () => {
      const GAP = 40;
      const limiter = new MinGapRateLimiter(GAP);
      const at: number[] = [];

      const started = Date.now();
      await Promise.all(
        Array.from({ length: 5 }, () => limiter.acquire().then(() => at.push(Date.now()))),
      );

      expect(at).toHaveLength(5);

      // Total span must cover at least 4 gaps (first is immediate).
      expect(Date.now() - started).toBeGreaterThanOrEqual(GAP * 4 * 0.8);

      // And each successive release is separated, not simultaneous.
      const sorted = [...at].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(GAP * 0.7);
      }
    });

    it('does not delay a lone acquirer', async () => {
      const limiter = new MinGapRateLimiter(100);
      const started = Date.now();
      await limiter.acquire();
      expect(Date.now() - started).toBeLessThan(50);
    });

    it('does not delay acquirers that arrive after the gap has elapsed', async () => {
      const limiter = new MinGapRateLimiter(20);
      await limiter.acquire();
      await new Promise((r) => setTimeout(r, 60));

      const started = Date.now();
      await limiter.acquire();
      expect(Date.now() - started).toBeLessThan(20);
    });
  });

  describe('resilience', () => {
    it('keeps working after a caller rejects', async () => {
      const limiter = new MinGapRateLimiter(10);

      // A rejecting continuation must not wedge the internal chain.
      await limiter
        .acquire()
        .then(() => {
          throw new Error('caller blew up');
        })
        .catch(() => undefined);

      await expect(limiter.acquire()).resolves.toBeUndefined();
      await expect(limiter.acquire()).resolves.toBeUndefined();
    });

    it('treats a zero gap as no throttling', async () => {
      const limiter = new MinGapRateLimiter(0);
      const started = Date.now();
      await Promise.all(Array.from({ length: 20 }, () => limiter.acquire()));
      expect(Date.now() - started).toBeLessThan(100);
    });

    it('rejects a negative gap at construction', () => {
      expect(() => new MinGapRateLimiter(-1)).toThrow(RangeError);
    });
  });
});
