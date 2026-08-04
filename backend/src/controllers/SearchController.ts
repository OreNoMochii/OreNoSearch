import { Request, Response } from 'express';
import {
    runIlikeSearch,
    getAvailableLocations,
    IlikeSearchParams,
} from '../repositories/postgres_repo';
import { meiliClient, ALLOWED_INDEXES } from '../repositories/meilisearch_repo';
import { SqlSearchRequest, MeiliProxyRequest } from '../core/schemas';
import { logInfo, logError } from '../utils/logger';

export class SearchController {
    /** POST /api/search — boolean search over the golden database. */
    static async runSearch(req: Request, res: Response): Promise<Response> {
        const parsed = SqlSearchRequest.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Invalid search request',
                details: parsed.error.issues.map((i) => ({
                    field: i.path.join('.'),
                    message: i.message,
                })),
            });
        }

        const body = parsed.data;
        const started = Date.now();

        try {
            const params: IlikeSearchParams = {
                andGroups: body.andGroups,
                must: body.must,
                should: body.should,
                mustNot: body.mustNot,
                locations: body.locations,
                limit: body.limit,
                minExp: body.minExp,
                maxExp: body.maxExp,
                excludeCompanies: body.excludeCompanies,
                currentRoleKeywords: body.currentRoleKeywords,
            };

            const result = await runIlikeSearch(params);

            logInfo('sql_search', {
                groups: body.andGroups.length,
                locations: body.locations.length,
                total: result.total,
                durationMs: Date.now() - started,
            });

            return res.json(result);
        } catch (err) {
            logError('sql_search_failed', err);
            // Never surface a driver message: it can leak schema and connection
            // details to the client.
            return res.status(500).json({ error: 'Search failed' });
        }
    }

    /** GET /api/locations — distinct normalised locations for the filter UI. */
    static async getLocations(_req: Request, res: Response): Promise<Response> {
        try {
            const locations = await getAvailableLocations();
            return res.json({ locations });
        } catch (err) {
            logError('get_locations_failed', err);
            return res.status(500).json({ error: 'Could not fetch locations' });
        }
    }

    /**
     * POST /api/meili/search — server-side Meilisearch proxy.
     *
     * B2: the browser previously held the Meilisearch **master** key, hardcoded
     * in searchClient.ts and inlined into the production bundle by Vite. Any
     * visitor could read it and gain full read/write/delete over the candidate
     * corpus. The key now stays on the server; the browser gets this endpoint,
     * which accepts only a search shape against an allowlisted index and cannot
     * reach settings, documents or task routes at all.
     */
    static async meiliSearch(req: Request, res: Response): Promise<Response> {
        const parsed = MeiliProxyRequest.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Invalid search request',
                details: parsed.error.issues.map((i) => ({
                    field: i.path.join('.'),
                    message: i.message,
                })),
            });
        }

        const { index, query, limit, offset, filter, attributesToRetrieve } = parsed.data;

        if (!ALLOWED_INDEXES.has(index)) {
            return res.status(400).json({ error: `Unknown index '${index}'` });
        }

        try {
            const result = await meiliClient.index(index).search(query, {
                limit,
                offset,
                ...(filter ? { filter } : {}),
                ...(attributesToRetrieve ? { attributesToRetrieve } : {}),
            });
            return res.json(result);
        } catch (err) {
            logError('meili_proxy_failed', err, { index });
            return res.status(502).json({ error: 'Search backend unavailable' });
        }
    }
}
