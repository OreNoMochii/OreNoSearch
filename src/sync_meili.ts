
import parseArgs from 'minimist';
import { Meilisearch } from 'meilisearch';
import pool from './database';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

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
    await index.updateFilterableAttributes(['months_in_current_role', 'current_company', 'location']);
    
    console.log('Fetching candidates in batches and adding to Meilisearch...');
    const BATCH_SIZE = 5000;
    let offset = 0;
    let batchNumber = 1;

    while (offset < totalCandidates) {
      const res = await client.query(`SELECT * FROM candidates_upgraded LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]);
      const candidates = res.rows;

      if (candidates.length === 0) break;

      // Transform data to match Outreach Agent expectations
      const documents = candidates.map(c => ({
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
        months_in_current_role: getMonthsInCurrentRole(c.experience)
      }));

      const task = await index.addDocuments(documents);
      console.log(`Submitted batch ${batchNumber} of ${Math.ceil(totalCandidates/BATCH_SIZE)} (Task UID: ${task.taskUid}, Records: ${offset + 1} - ${offset + candidates.length})`);
      
      offset += BATCH_SIZE;
      batchNumber++;
    }

    console.log('--- Document Submission successful! ---');
    console.log('Indexing tasks submitted to Meilisearch.');
    console.log('Meilisearch will index these documents asynchronously.');
    console.log('You can check progress via health/stats endpoints.');

  } catch (error) {
    console.error('Error during synchronization:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

syncPostgresToMeili();
