import pool, { initDb } from './database';
import { config } from './config';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://api.deepinfra.com/v1/openai',
});

async function extractLatestRole(experience: string): Promise<string> {
  if (!experience) return '';
  try {
    const completion = await client.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content:
            "You are an AI that extracts the most recent job role/title from a candidate's experience text. Return only the job title name, and nothing else. Keep it under 255 characters. Do not include company names or dates.",
        },
        { role: 'user', content: `Experience:\n${experience}\n\nWhat is the most recent role?` },
      ],
      temperature: 0.1,
    });
    return completion.choices[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('Failed to extract latest role:', e);
    return '';
  }
}

async function run() {
  await initDb();

  console.log('Fetching candidates without a latest_role...');
  const result = await pool.query(`
        SELECT name, profile_url, experience 
        FROM candidates 
        WHERE experience IS NOT NULL AND experience != '' 
        AND (latest_role IS NULL OR latest_role = '')
    `);

  console.log(`Found ${result.rows.length} candidates.`);

  // Process in batches of 5 to avoid rate-limiting
  const batchSize = 5;
  for (let i = 0; i < result.rows.length; i += batchSize) {
    const batch = result.rows.slice(i, i + batchSize);
    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(result.rows.length / batchSize)}...`,
    );

    await Promise.all(
      batch.map(async (row) => {
        const role = await extractLatestRole(row.experience);
        if (role) {
          await pool.query(
            `
                    UPDATE candidates 
                    SET latest_role = $1 
                    WHERE profile_url = $2
                `,
            [role, row.profile_url],
          );
          console.log(` ✅ Updated [${row.name}] -> ${role}`);
        } else {
          console.log(` ⚠️ Could not extract role for [${row.name}]`);
        }
      }),
    );
  }

  console.log('Backfill complete!');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
