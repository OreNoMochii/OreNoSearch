/**
 * rate_limiter.ts — serialised minimum-gap limiter.
 *
 * B6: the previous implementation was
 *
 *     const now = Date.now();
 *     const elapsed = now - _lastRequestTime;          // read
 *     if (elapsed < GAP) await sleep(GAP - elapsed);   // yield
 *     _lastRequestTime = Date.now();                   // write
 *
 * The read and the write are separated by an await. Every member of a
 * concurrent wave observed the same `_lastRequestTime`, computed the same
 * delay, and resumed in the same tick — so the limiter enforced nothing. That
 * is why the adaptive-concurrency machinery in OutreachService existed: it was
 * compensating for a limiter that never worked.
 *
 * Here each caller reserves its slot synchronously inside one link of a promise
 * chain, so the reservation is atomic with respect to other callers.
 */
export class MinGapRateLimiter {
    private tail: Promise<void> = Promise.resolve();
    private nextFreeAt = 0;

    constructor(private readonly minGapMs: number) {
        if (minGapMs < 0) throw new RangeError('minGapMs must be >= 0');
    }

    acquire(): Promise<void> {
        const run = this.tail.then(() => {
            const now = Date.now();
            const startAt = Math.max(now, this.nextFreeAt);
            // Committed before any await — this is what makes it atomic.
            this.nextFreeAt = startAt + this.minGapMs;

            const waitMs = startAt - now;
            return waitMs > 0
                ? new Promise<void>((resolve) => setTimeout(resolve, waitMs))
                : undefined;
        });

        // Keep the chain alive even if one caller's continuation rejects,
        // otherwise a single failure would wedge the limiter permanently.
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );

        return run;
    }
}
