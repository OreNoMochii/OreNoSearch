import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual, createHash } from 'crypto';

import { config } from './config';
import { logInfo, logWarn, logError, logger } from './utils/logger';
import { OutreachController } from './controllers/OutreachController';
import { SearchController } from './controllers/SearchController';
import { pool, shutdownPool } from './repositories/postgres_repo';
import { shutdownQueue } from './controllers/OutreachController';
import { shutdownRedis } from './infrastructure/redis';
import { initMeiliSettings } from './repositories/meilisearch_repo';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // required for correct req.ip behind the Vite proxy
app.use(helmet());

app.use(
  cors({
    // B4: `cors()` with no arguments emits Access-Control-Allow-Origin: *
    // on an authenticated API. Origins are now an explicit allowlist.
    origin: config.ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400,
  }),
);

// ── Health probes — before auth so orchestrators can reach them ─────────────
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    logError('readiness_failed', err as Error);
    res.status(503).json({ status: 'not-ready' });
  }
});

// ── Request logging ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/queue-status' || req.path === '/healthz') return;
    logInfo('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      ip: req.ip,
    });
  });
  next();
});

// ── Authentication ──────────────────────────────────────────────────────────
/**
 * Constant-time credential comparison.
 *
 * B4: the previous check used `===`, whose early exit leaks the length of the
 * matching prefix through response timing. Hashing first guarantees both
 * operands are 32 bytes, so timingSafeEqual cannot throw on length mismatch.
 */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  );
}

function challenge(res: express.Response): void {
  res.set('WWW-Authenticate', 'Basic realm="Metaview API", charset="UTF-8"');
  res.status(401).json({ error: 'Authentication required' });
}

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts' },
});

app.use(authLimiter, (req, res, next) => {
  if (req.method === 'OPTIONS') return next();

  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return challenge(res);

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  // Split on the FIRST colon only — a password may legitimately contain one.
  const sep = decoded.indexOf(':');
  if (sep === -1) return challenge(res);

  // Both comparisons always run: no early exit on a wrong username.
  const okUser = safeEqual(decoded.slice(0, sep), config.API_USER);
  const okPass = safeEqual(decoded.slice(sep + 1), config.API_PASS);

  if (okUser && okPass) return next();

  logWarn('auth_failed', { ip: req.ip, path: req.path });
  return challenge(res);
});

// ── Body parsing — deliberately AFTER auth ──────────────────────────────────
// B4: the previous order let an unauthenticated client make the server buffer
// and parse a 50 MB JSON body before the 401 was issued.
app.use(express.json({ limit: config.MAX_BODY_SIZE }));

// ── Routes ──────────────────────────────────────────────────────────────────
const outreachLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.post('/api/outreach', outreachLimiter, OutreachController.triggerOutreach);
app.get('/api/queue-status', OutreachController.getQueueStatus);
app.post('/api/search', SearchController.runSearch);
app.post('/api/meili/search', SearchController.meiliSearch);
app.get('/api/locations', SearchController.getLocations);

// ── Terminal error handler ──────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError('unhandled_route_error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ─────────────────────────────────────────────────────────────────
const server = app.listen(config.PORT, config.HOST, () => {
  logInfo('server_started', {
    port: config.PORT,
    host: config.HOST,
    env: config.NODE_ENV,
    allowedOrigins: config.ALLOWED_ORIGINS,
  });

  // Index settings are applied here rather than from the browser — needing
  // this write is why the client previously carried an admin key (B2).
  void initMeiliSettings().catch((err) => logError('meili_settings_init_failed', err));
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
// Previously absent entirely: SIGTERM killed in-flight campaigns mid-write.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo('shutdown_started', { signal });

    server.close(() => {
      // Order matters: stop the worker first so no job is killed
      // mid-write, then release the datastore connections it was using.
      void (async () => {
        try {
          await shutdownQueue();
        } catch (err) {
          logError('queue_shutdown_failed', err);
        }
        try {
          await shutdownRedis();
        } catch (err) {
          logError('redis_shutdown_failed', err);
        }
        await shutdownPool().catch((err) => logError('pool_shutdown_failed', err));
      })().finally(() => {
        logInfo('shutdown_complete');
        process.exit(0);
      });
    });

    // Never hang forever waiting on a stuck connection.
    setTimeout(() => {
      logError('shutdown_forced', new Error('Graceful shutdown timed out'));
      process.exit(1);
    }, 30_000).unref();
  });
}

process.on('unhandledRejection', (reason) => logError('unhandled_rejection', reason));
process.on('uncaughtException', (err) => {
  logError('uncaught_exception', err);
  logger.flush?.();
  process.exit(1);
});

export { app, server };
