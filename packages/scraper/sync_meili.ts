import parseArgs from 'minimist';
import { Meilisearch } from 'meilisearch';
import type { PoolClient } from 'pg';
import pool from './database';

const args = parseArgs(process.argv.slice(2));
const clearIndex = args.clear || false;

const MEILI_URL = process.env.MEILI_URL || 'http://localhost:7700';
const MEILI_KEY = process.env.MEILI_KEY;
const MEILI_INDEX = process.env.MEILI_INDEX || 'candidates';

const meiliClient = new Meilisearch({
  host: MEILI_URL,
  apiKey: MEILI_KEY,
});

/**
 * Encodes a string to be a valid Meilisearch document ID.
 * Document ID must be a string containing only alphanumeric characters (a-z, A-Z, 0-9), hyphens (-), and underscores (_).
 */
function encodeId(url: string): string {
  return Buffer.from(url).toString('hex');
}

/**
 * Extracts the duration of the current role in months from the experience string.
 * Example: "Now (1 yr 2 mos)" -> 14.
 * Returns 12 if no "Now" match is found (assuming they pass filter if not currently changing jobs).
 */
function getMonthsInCurrentRole(experience?: string): number {
  if (!experience) return 12;
  const match = experience.match(/Now \((.*?)\)/i);
  if (!match) return 12; // If they don't have a current role listed, default to passing the filter.

  const durationStr = match[1];
  let months = 0;

  const yrMatch = durationStr.match(/(\d+)\s*yr/i);
  if (yrMatch) {
    months += parseInt(yrMatch[1], 10) * 12;
  }

  const moMatch = durationStr.match(/(\d+)\s*mo/i);
  if (moMatch) {
    months += parseInt(moMatch[1], 10);
  }

  return months;
}

/**
 * Refreshes the location snapshot that backs GET /api/locations.
 *
 * candidate_location_counts (migration 006) is a materialised view, so regions
 * introduced by a scrape do not reach the filter UI until it is rebuilt. This
 * is the natural hook: the sync runs after the scraper has finished writing,
 * and it already holds a connection.
 *
 * CONCURRENTLY keeps the view readable while it rebuilds. Advisory — a failure
 * here means a slightly stale filter list, never a failed sync.
 */
async function refreshLocationCounts(client: PoolClient): Promise<void> {
  try {
    const exists = await client.query(
      `SELECT 1 FROM pg_class WHERE relname = 'candidate_location_counts' AND relkind = 'm' LIMIT 1`,
    );
    if ((exists.rowCount ?? 0) === 0) {
      console.warn(
        '[locations] candidate_location_counts not found — skipping refresh. ' +
          'Apply packages/scraper/migrations/006_location_counts_matview.sql.',
      );
      return;
    }

    console.log('Refreshing location counts (materialized view)...');
    const started = Date.now();
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY candidate_location_counts');
    console.log(`Location counts refreshed in ${Date.now() - started}ms.`);
  } catch (e: any) {
    console.warn(`Warning: could not refresh location counts: ${e.message}`);
  }
}

async function syncPostgresToMeili() {
  console.log('--- Starting PostgreSQL to Meilisearch Synchronization ---');

  if (!MEILI_KEY) {
    console.error('Error: MEILI_KEY is not set in .env');
    process.exit(1);
  }

  const index = meiliClient.index(MEILI_INDEX);

  if (clearIndex) {
    console.log(`Clearing index "${MEILI_INDEX}" before re-indexing...`);
    try {
      const deleteWait = await index.deleteAllDocuments();
      console.log(`Clear task submitted (Task UID: ${deleteWait.taskUid})`);
    } catch (e: any) {
      console.warn(`Warning: Could not clear index (it might not exist yet): ${e.message}`);
    }
  }

  const client = await pool.connect();
  try {
    const countRes = await client.query('SELECT COUNT(*) FROM candidates_upgraded');
    const totalCandidates = parseInt(countRes.rows[0].count, 10);
    console.log(`Found ${totalCandidates} candidates in database.`);

    if (totalCandidates === 0) {
      console.log('No candidates to sync. Exiting.');
      return;
    }

    const index = meiliClient.index(MEILI_INDEX);

    // Ensure months_in_current_role, current_company, and location are filterable
    console.log('Updating filterableAttributes in Meilisearch...');
    await index.updateFilterableAttributes([
      'months_in_current_role',
      'current_company',
      'location',
    ]);

    console.log('Fetching candidates in batches and adding to Meilisearch...');
    const BATCH_SIZE = 5000;
    let batchNumber = 1;
    let synced = 0;

    // Keyset pagination on the primary key, not LIMIT/OFFSET.
    //
    // OFFSET makes Postgres produce and discard every row before the offset, so
    // walking a 5.66M-row table 5,000 at a time scanned roughly N^2/2B rows in
    // total — about 3.2 billion row-visits to return 5.66 million. Each batch is
    // now an index range scan of exactly BATCH_SIZE rows.
    //
    // The explicit column list replaces SELECT *: scraped_at aside, every column
    // below is actually indexed into Meilisearch, and the wildcard dragged
    // whatever else the table happens to carry across the wire.
    let cursor = '';

    for (;;) {
      const res = await client.query(
        `SELECT profile_url, name, email, headline, current_company, latest_role,
                experience, location, skills, summary, phone_number, education,
                language, licenses, scraped_at
         FROM   candidates_upgraded
         WHERE  profile_url > $1
         ORDER  BY profile_url
         LIMIT  $2`,
        [cursor, BATCH_SIZE],
      );
      const candidates = res.rows;

      if (candidates.length === 0) break;

      // Transform data to match Outreach Agent expectations
      const documents = candidates.map((c) => ({
        id: encodeId(c.profile_url),
        name: c.name,
        email: c.email || '',
        headline: c.headline || '',
        current_company: c.current_company || '',
        latest_role: c.latest_role || '',
        experience: c.experience || '',
        location: c.location || '',
        skills: c.skills || '',
        summary: c.summary || '',
        phone_number: c.phone_number || '',
        education: c.education || '',
        language: c.language || '',
        licenses: c.licenses || '',
        profile_url: c.profile_url,
        scraped_at: c.scraped_at,
        months_in_current_role: getMonthsInCurrentRole(c.experience),
      }));

      const task = await index.addDocuments(documents);
      console.log(
        `Submitted batch ${batchNumber} of ~${Math.ceil(totalCandidates / BATCH_SIZE)} ` +
          `(Task UID: ${task.taskUid}, Records: ${synced + 1} - ${synced + candidates.length})`,
      );

      synced += candidates.length;
      cursor = candidates[candidates.length - 1].profile_url as string;
      batchNumber++;
    }

    console.log(`Submitted ${synced} candidates across ${batchNumber - 1} batches.`);

    console.log('--- Document Submission successful! ---');
    console.log('Indexing tasks submitted to Meilisearch.');
    console.log('Meilisearch will index these documents asynchronously.');
    console.log('You can check progress via health/stats endpoints.');

    await refreshLocationCounts(client);
  } catch (error) {
    console.error('Error during synchronization:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

syncPostgresToMeili();
