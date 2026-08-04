import { Meilisearch } from 'meilisearch';
import dotenv from 'dotenv';
import { logDebug } from '../utils/logger';

import { z } from 'zod';

import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') }); // Adjust relative path as needed

const MEILI_URL = process.env.MEILI_URL || 'http://localhost:7700';
const MEILI_KEY = process.env.MEILI_KEY;
const MEILI_INDEX = process.env.MEILI_INDEX || 'candidates';

export const meiliClient = new Meilisearch({
    host: MEILI_URL,
    apiKey: MEILI_KEY
});

const settingsUpdated = new Map<string, Promise<void>>();

function ensureMaxTotalHits(indexName: string): Promise<void> {
  if (!settingsUpdated.has(indexName)) {
    const promise = (async () => {
      try {
        const index = meiliClient.index(indexName);
        const task = await index.updateSettings({ pagination: { maxTotalHits: 100000 } });
        await meiliClient.waitForTask(task.taskUid);
      } catch (err) {
        logDebug(`Failed to update maxTotalHits for ${indexName}`);
      }
    })();
    settingsUpdated.set(indexName, promise);
  }
  return settingsUpdated.get(indexName)!;
}

/**
 * Meilisearch caps results at maxTotalHits (default 1000) regardless of the `limit` param.
 * This helper raises that cap to 100 000 then paginates through all results in pages of 1000.
 */
export async function fetchAllMeiliHits(indexName: string, query: string): Promise<any[]> {
    const PAGE_SIZE = 1000;
    const index = meiliClient.index(indexName);

    await ensureMaxTotalHits(indexName);

    const all: any[] = [];
    let offset = 0;

    while (true) {
        const res: any = await index.search(query, { limit: PAGE_SIZE, offset });
        const hits: any[] = res.hits || [];
        all.push(...hits);
        if (hits.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return all;
}

export async function fetchCandidatesHybrid(searchData: any): Promise<any[]> {
    logDebug("\n--- Pre-Filtering Candidates (Meilisearch Only) ---");
    const unified: any[] = [];
    const seenUrls = new Set<string>();

    logDebug(`  [Meilisearch] Extracting for Keywords: ${searchData.keywords.join(', ')}`);

    const queryTerm = searchData.keywords.map((kw: string) => kw.includes(' ') ? `"${kw}"` : kw).join(' ');
    logDebug(`  [Meilisearch] Combined AND Query: \`${queryTerm}\``);

    let keywordHitCount = 0;

    try {
        try {
            const profileHits = await fetchAllMeiliHits('profiles', queryTerm);
            profileHits.forEach((h: any) => {
                const url = h.profile_url || h.id;
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    keywordHitCount++;
                    unified.push({
                        name: h.name || 'Unknown',
                        profile_url: h.profile_url || '',
                        headline: h.current_role || 'N/A',
                        location: h.location || 'N/A',
                        current_company: h.company || 'N/A',
                        summary: h.summary || 'N/A',
                        email: h.email || 'N/A',
                        phone_number: 'N/A',
                        experience: h.experience || 'N/A',
                        education: h.education || 'N/A',
                        skills: h.skills || 'N/A',
                        language: h.language || 'N/A',
                        licenses: h.licenses || 'N/A',
                        source: 'profiles'
                    });
                }
            });
        } catch (e: any) {}

        try {
            const candidateHits = await fetchAllMeiliHits(MEILI_INDEX, queryTerm);
            candidateHits.forEach((h: any) => {
                const url = h.profile_url || h.id;
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    keywordHitCount++;
                    unified.push({
                        name: h.name || 'Unknown',
                        profile_url: h.profile_url || '',
                        headline: h.headline || 'N/A',
                        location: h.location || 'N/A',
                        current_company: h.current_company || 'N/A',
                        summary: h.summary || 'N/A',
                        email: h.email || 'N/A',
                        phone_number: h.phone_number || 'N/A',
                        experience: h.experience || '',
                        education: h.education || 'N/A',
                        skills: h.skills || 'N/A',
                        language: h.language || 'N/A',
                        licenses: h.licenses || 'N/A',
                        source: 'candidates'
                    });
                }
            });
        } catch (e: any) {}
        logDebug(`  [Meilisearch] Query \`${queryTerm}\` yielded ${keywordHitCount} total unique hits across indices.`);
    } catch (error: any) {
        logDebug(`  [Meilisearch Error] ${error.message}`);
    }

    logDebug(`  [Meilisearch Total] Final unique candidate pool: ${unified.length}`);
    return unified;
}
