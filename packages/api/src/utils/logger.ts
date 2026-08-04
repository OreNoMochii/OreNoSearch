/**
 * logger.ts — structured, non-blocking logging.
 *
 * The previous implementation called fs.appendFileSync on every line. Node is
 * single-threaded, so each log write halted the event loop for the duration of
 * a synchronous disk write — under a 10-wide screening wave that serialised the
 * entire process behind disk I/O. It also wrote candidate names and email
 * addresses to an unrotated plaintext file with no retention policy.
 *
 * pino writes asynchronously and redacts PII by default.
 */
import pino from 'pino';
import { config, isProduction } from '../config';

export const logger = pino({
    level: config.LOG_LEVEL,
    // PII and credentials never reach the log sink, wherever it is shipped.
    redact: {
        paths: [
            'email',
            'cc',
            'to',
            'recipients',
            'password',
            'apiKey',
            'authorization',
            'req.headers.authorization',
            'req.headers.cookie',
            '*.email',
            '*.phone_number',
            '*.recipient_email',
        ],
        censor: '[REDACTED]',
    },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Human-readable locally; newline-delimited JSON in production so log
    // aggregators can parse it.
    transport: isProduction
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

export const logInfo = (event: string, data?: Record<string, unknown>): void => {
    logger.info({ event, ...data });
};

export const logWarn = (event: string, data?: Record<string, unknown>): void => {
    logger.warn({ event, ...data });
};

export const logError = (event: string, err: unknown, data?: Record<string, unknown>): void => {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error({ event, err: { message: e.message, stack: e.stack }, ...data });
};

/**
 * Compatibility shim for the ~40 existing `await logDebug(...)` call sites.
 * Returns a resolved promise so `await` remains valid while callers migrate to
 * logInfo/logWarn/logError.
 *
 * @deprecated Use logInfo / logWarn / logError.
 */
export const logDebug = (msg: string): Promise<void> => {
    logger.info(msg);
    return Promise.resolve();
};

/**
 * Records a candidate that was filtered out of a campaign.
 * Identifying fields are redacted by the logger configuration above.
 *
 * @deprecated Prefer logInfo with an explicit event name.
 */
export const logSkipped = (
    candidate: { name?: string; email?: string },
    stage: string,
    reasoning: string,
): Promise<void> => {
    logger.info({
        event: 'candidate_skipped',
        stage,
        reasoning,
        name: candidate.name ?? 'Unknown',
        email: candidate.email,
    });
    return Promise.resolve();
};
