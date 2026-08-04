import Redis from 'ioredis';
import { config } from '../config';
import { logInfo, logWarn, logError } from '../utils/logger';

/**
 * Shared Redis connection.
 *
 * B25: the client was previously constructed at module scope with no 'error'
 * listener. ioredis is an EventEmitter, and Node terminates the process when an
 * EventEmitter emits 'error' with nothing listening — so a Redis that was down
 * at boot, restarting, or briefly unreachable killed the whole API rather than
 * degrading the one feature that needs it.
 *
 * The connection now reports its state, backs off on reconnect, and exposes
 * `isAvailable()` so callers can fail a single request instead of the process.
 */

let connection: Redis | null = null;
let available = false;

export function getRedis(): Redis {
  if (connection) return connection;

  connection = new Redis(config.REDIS_URL, {
    // BullMQ requires this to be null: it uses blocking commands whose
    // retry budget must not be capped.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    // Bounded exponential backoff, capped at 10s, so a long outage does not
    // become a tight reconnect loop.
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 10_000);
      if (times === 1 || times % 10 === 0) {
        logWarn('redis_reconnecting', { attempt: times, delayMs: delay });
      }
      return delay;
    },
  });

  // The listener that keeps an unreachable Redis from killing the process.
  connection.on('error', (err: Error) => {
    available = false;
    logError('redis_error', err);
  });

  connection.on('ready', () => {
    available = true;
    logInfo('redis_ready', { url: redactUrl(config.REDIS_URL) });
  });

  connection.on('close', () => {
    available = false;
    logWarn('redis_closed');
  });

  connection.on('end', () => {
    available = false;
    logWarn('redis_connection_ended');
  });

  return connection;
}

/** True when the connection is usable right now. */
export function isRedisAvailable(): boolean {
  return available && connection?.status === 'ready';
}

/** Closes the connection during graceful shutdown. */
export async function shutdownRedis(): Promise<void> {
  if (!connection) return;
  try {
    await connection.quit();
  } catch {
    // quit() rejects if the socket is already gone; force it closed.
    connection.disconnect();
  } finally {
    connection = null;
    available = false;
  }
}

/** Strips credentials before a connection string reaches the logs. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return '<unparseable redis url>';
  }
}
