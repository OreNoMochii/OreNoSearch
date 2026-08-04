import { Request, Response } from 'express';
import { runIlikeSearch, IlikeSearchParams } from '../repositories/postgres_repo';
import { logDebug } from '../utils/logger';

export class SearchController {
    static async runSearch(req: Request, res: Response) {
        try {
            const { 
                should, must, mustNot, andGroups, 
                locations, limit, minExp, maxExp, 
                excludeCompanies, currentRoleKeywords 
            } = req.body;

            await logDebug(`[SQL Search] andGroups: ${JSON.stringify(andGroups)} | must: ${JSON.stringify(must)} | should: ${JSON.stringify(should)} | mustNot: ${JSON.stringify(mustNot)} | locations: ${locations?.join(', ')}`);

            const params: IlikeSearchParams = {
                andGroups: andGroups || [],
                must: must || [],
                should: should || [],
                mustNot: mustNot || [],
                locations: locations || [],
                limit: limit || 25,
                minExp,
                maxExp,
                excludeCompanies,
                currentRoleKeywords
            };

            const result = await runIlikeSearch(params);
            
            return res.json(result);
            
        } catch (error: any) {
            console.error("SearchController Error:", error);
            return res.status(500).json({ error: error.message || "An error occurred during search." });
        }
    }

    static async getLocations(req: Request, res: Response) {
        try {
            const { getAvailableLocations } = require('../repositories/postgres_repo');
            const locations = await getAvailableLocations();
            return res.json({ locations });
        } catch (error: any) {
            console.error("SearchController getLocations Error:", error);
            return res.status(500).json({ error: error.message || "An error occurred fetching locations." });
        }
    }
}
