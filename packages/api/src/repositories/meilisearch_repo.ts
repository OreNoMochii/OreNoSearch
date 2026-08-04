import { Meilisearch } from 'meilisearch';
import { config } from '../config';
import { logWarn } from '../utils/logger';

/**
 * Server-side Meilisearch client. This holds the privileged key and must never
 * be exposed to the browser — client search traffic is proxied through
 * SearchController.meiliSearch instead.
 */
export const meiliClient = new Meilisearch({
    host: config.MEILI_URL,
    apiKey: config.MEILI_KEY,
});

/** Indexes the API is permitted to query on behalf of a client. */
export const ALLOWED_INDEXES: ReadonlySet<string> = new Set(['candidates', 'profiles']);

const settingsUpdated = new Map<string, Promise<void>>();

/**
 * Raises Meilisearch's maxTotalHits so deep pagination returns real results.
 *
 * This is a privileged settings write and now runs only here, on the server.
 * The browser used to perform it, which is why the client needed an
 * admin-grade key in the first place (B2).
 */
export function ensureMaxTotalHits(indexName: string): Promise<void> {
    if (!settingsUpdated.has(indexName)) {
        const promise = (async () => {
            try {
                const index = meiliClient.index(indexName);
                const task = await index.updateSettings({ pagination: { maxTotalHits: 100_000 } });
                await meiliClient.tasks.waitForTask(task.taskUid);
            } catch (err) {
                logWarn('meili_settings_update_failed', {
                    index: indexName,
                    message: (err as Error).message,
                });
            }
        })();
        settingsUpdated.set(indexName, promise);
    }
    return settingsUpdated.get(indexName)!;
}

/** Applies index settings once at server startup. */
export async function initMeiliSettings(): Promise<void> {
    await Promise.all([...ALLOWED_INDEXES].map((i) => ensureMaxTotalHits(i)));
}
