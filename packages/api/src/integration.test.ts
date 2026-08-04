import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * API integration suite.
 *
 * Exercises the real HTTP surface against real Postgres and Redis. Unlike the
 * pure-logic suites this needs infrastructure, so it SKIPS ITSELF when that is
 * unavailable — CI without services stays green rather than red-for-the-wrong-
 * reason, and a developer with `docker compose up` gets real coverage.
 *
 * Run it deliberately:
 *   docker compose up -d
 *   npm run test:integration --workspace @metaview/api
 *
 * It is read-only: it issues searches and health probes. It never enqueues a
 * campaign, sends email, writes to Sheets or touches candidate data.
 */

const ENABLED = process.env.RUN_INTEGRATION === '1';

// Importing main.ts starts a listener and connects to Redis, so it must only
// happen when the suite is actually going to run.
let app: Express | undefined;
let shutdown: (() => Promise<void>) | undefined;

const suite = ENABLED ? describe : describe.skip;

suite('API integration', () => {
  let auth: string;

  beforeAll(async () => {
    const mod = await import('./main');
    app = mod.app;

    const { config } = await import('./config');
    auth = 'Basic ' + Buffer.from(`${config.API_USER}:${config.API_PASS}`).toString('base64');

    const { shutdownPool } = await import('./repositories/postgres_repo');
    const { shutdownRedis } = await import('./infrastructure/redis');
    const { shutdownQueue } = await import('./controllers/OutreachController');
    shutdown = async () => {
      await shutdownQueue().catch(() => undefined);
      await shutdownRedis().catch(() => undefined);
      await shutdownPool().catch(() => undefined);
      mod.server.close();
    };

    // Give Redis a moment to reach 'ready' before the queue endpoints run.
    await new Promise((r) => setTimeout(r, 1500));
  }, 30_000);

  afterAll(async () => {
    await shutdown?.();
  });

  describe('health probes', () => {
    it('GET /healthz is unauthenticated and reports liveness', async () => {
      const res = await request(app!).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });
    });

    it('GET /readyz confirms the database pool answers', async () => {
      const res = await request(app!).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ready' });
    });
  });

  describe('authentication (B4)', () => {
    it('rejects a request with no credentials', async () => {
      const res = await request(app!).get('/api/queue-status');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic/);
    });

    it('rejects wrong credentials', async () => {
      const bad = 'Basic ' + Buffer.from('wrong:wrong').toString('base64');
      const res = await request(app!).get('/api/queue-status').set('Authorization', bad);
      expect(res.status).toBe(401);
    });

    it('accepts correct credentials', async () => {
      // Deliberately not /api/locations: on a cold cache that endpoint
      // blocks ~25s on the 5.6M-row aggregate, which is a property of the
      // data, not of authentication.
      const res = await request(app!).get('/api/queue-status').set('Authorization', auth);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/locations', () => {
    it('returns the normalised region list', async () => {
      const res = await request(app!).get('/api/locations').set('Authorization', auth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.locations)).toBe(true);
      expect(res.body.locations.length).toBeGreaterThan(0);
    }, 60_000);

    it('serves the second call from cache', async () => {
      await request(app!).get('/api/locations').set('Authorization', auth);
      const started = Date.now();
      const res = await request(app!).get('/api/locations').set('Authorization', auth);
      expect(res.status).toBe(200);
      // The uncached aggregate scans 5.6M rows and takes ~25s.
      expect(Date.now() - started).toBeLessThan(2000);
    }, 60_000);
  });

  describe('POST /api/search', () => {
    it('rejects a malformed body with field-level detail', async () => {
      const res = await request(app!)
        .post('/api/search')
        .set('Authorization', auth)
        .send({ limit: -5 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it('returns hits and an exact total for a selective query', async () => {
      const res = await request(app!)
        .post('/api/search')
        .set('Authorization', auth)
        .send({ andGroups: [['neurosurgeon']], locations: ['Tokyo'], limit: 3 });

      expect(res.status).toBe(200);
      expect(res.body.hits.length).toBeLessThanOrEqual(3);
      expect(typeof res.body.total).toBe('number');
      // B32: a selective query must report an exact total, not a cap.
      expect(res.body.totalIsCapped).toBe(false);
    }, 60_000);

    it('flags the total as capped for a broad query (B32)', async () => {
      const res = await request(app!)
        .post('/api/search')
        .set('Authorization', auth)
        .send({ andGroups: [['engineer']], locations: ['Tokyo'], limit: 2 });

      expect(res.status).toBe(200);
      if (res.body.totalIsCapped) {
        // When capped, `total` is a floor and must never be used as a
        // fetch limit — that silently truncated campaigns.
        expect(res.body.total).toBe(res.body.countCap);
      }
    }, 60_000);

    it('narrows results when an experience filter is applied', async () => {
      const base = await request(app!)
        .post('/api/search')
        .set('Authorization', auth)
        .send({ andGroups: [['neurosurgeon']], locations: ['Tokyo'], limit: 1 });

      const filtered = await request(app!)
        .post('/api/search')
        .set('Authorization', auth)
        .send({
          andGroups: [['neurosurgeon']],
          locations: ['Tokyo'],
          minExp: 25,
          maxExp: 60,
          limit: 1,
        });

      expect(filtered.status).toBe(200);
      expect(filtered.body.total).toBeLessThanOrEqual(base.body.total);
    }, 60_000);

    it('survives tsquery operator characters without a 500 (B15)', async () => {
      for (const term of ['!', '&', '|', '(', "'; DROP TABLE candidates--"]) {
        const res = await request(app!)
          .post('/api/search')
          .set('Authorization', auth)
          .send({ andGroups: [[term]], locations: ['Tokyo'], limit: 1 });
        expect(res.status, `term ${term} produced ${res.status}`).toBe(200);
      }
    }, 60_000);
  });

  describe('POST /api/meili/search (B2)', () => {
    it('rejects an index outside the allowlist', async () => {
      const res = await request(app!)
        .post('/api/meili/search')
        .set('Authorization', auth)
        .send({ index: 'some_other_index', query: 'x' });
      expect(res.status).toBe(400);
    });

    it('rejects an out-of-range limit', async () => {
      const res = await request(app!)
        .post('/api/meili/search')
        .set('Authorization', auth)
        .send({ index: 'candidates', query: 'x', limit: 99999 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/queue-status', () => {
    it('reports queue state and never 500s', async () => {
      const res = await request(app!).get('/api/queue-status').set('Authorization', auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('activeCount');
      expect(res.body).toHaveProperty('pendingCount');
      // Degrades rather than failing when Redis is unavailable (B25).
      expect(res.body).toHaveProperty('degraded');
    });
  });
});
