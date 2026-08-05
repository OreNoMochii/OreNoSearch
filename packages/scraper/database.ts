import { Pool } from 'pg';
import { config } from './config';

const pool = new Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'metaview-scraper',
});

// Without a handler, an idle-client error is an uncaught exception.
pool.on('error', (err) => console.error('[pg pool]', err.message));

export interface Candidate {
  name: string;
  profile_url: string;
  headline?: string;
  location?: string;
  current_company?: string;
  summary?: string;
  email?: string;
  phone_number?: string;
  experience?: string;
  latest_role?: string;
  education?: string;
  skills?: string;
  language?: string;
  licenses?: string;
}

export async function initDb() {
  // Schema changes must be deliberate, never a side effect of a scrape.
  // Every statement below is IF NOT EXISTS, so this is a no-op against the
  // current schema — but it is still DDL against the golden database.
  if (!config.ALLOW_SCHEMA_INIT) {
    console.warn('[initDb] skipped: set ALLOW_SCHEMA_INIT=1 to apply schema DDL.');
    return;
  }

  const client = await pool.connect();
  try {
    const queryText = `
      CREATE TABLE IF NOT EXISTS candidates (
        name VARCHAR(255) NOT NULL,
        profile_url VARCHAR(500) NOT NULL,
        headline TEXT,
        location VARCHAR(255),
        current_company VARCHAR(255),
        summary TEXT,
        email VARCHAR(255),
        phone_number VARCHAR(50),
        experience TEXT,
        latest_role VARCHAR(255),
        education TEXT,
        skills TEXT,
        language TEXT,
        licenses TEXT,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (profile_url)
      );
      
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='candidates' AND column_name='summary') THEN
          ALTER TABLE candidates ADD COLUMN summary TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='candidates' AND column_name='latest_role') THEN
          ALTER TABLE candidates ADD COLUMN latest_role VARCHAR(255);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_candidates_profile_url ON candidates(profile_url);

      CREATE TABLE IF NOT EXISTS candidates_upgraded (
        name VARCHAR(255) NOT NULL,
        profile_url VARCHAR(500) NOT NULL,
        headline TEXT,
        location VARCHAR(255),
        current_company VARCHAR(255),
        summary TEXT,
        email VARCHAR(255),
        phone_number VARCHAR(50),
        experience TEXT,
        latest_role VARCHAR(255),
        education TEXT,
        skills TEXT,
        language TEXT,
        licenses TEXT,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (profile_url)
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_upgraded_profile_url ON candidates_upgraded(profile_url);

      CREATE TABLE IF NOT EXISTS outreach_history (
        id SERIAL PRIMARY KEY,
        profile_url VARCHAR(500) NOT NULL,
        recipient_email VARCHAR(255) NOT NULL,
        company_name VARCHAR(255),
        job_name VARCHAR(255),
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(profile_url, recipient_email, company_name)
      );
      CREATE INDEX IF NOT EXISTS idx_outreach_history_lookup ON outreach_history(profile_url, recipient_email);
    `;
    await client.query(queryText);
    console.log('Database initialized successfully.');
  } finally {
    client.release();
  }
}

export async function saveCandidate(candidate: Candidate, tableName: string = 'candidates') {
  const client = await pool.connect();
  const safeTableName = tableName === 'candidates_upgraded' ? 'candidates_upgraded' : 'candidates';

  try {
    const queryText = `
      INSERT INTO ${safeTableName} (
        name, profile_url, headline, location, current_company, summary,
        email, phone_number, experience, latest_role, education, skills, 
        language, licenses
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (profile_url) DO UPDATE SET
        name = EXCLUDED.name,
        headline = EXCLUDED.headline,
        location = EXCLUDED.location,
        current_company = EXCLUDED.current_company,
        summary = EXCLUDED.summary,
        email = COALESCE(EXCLUDED.email, ${safeTableName}.email),
        phone_number = COALESCE(EXCLUDED.phone_number, ${safeTableName}.phone_number),
        experience = EXCLUDED.experience,
        latest_role = EXCLUDED.latest_role,
        education = EXCLUDED.education,
        skills = EXCLUDED.skills,
        language = EXCLUDED.language,
        licenses = EXCLUDED.licenses,
        scraped_at = CURRENT_TIMESTAMP;
    `;
    const values = [
      candidate.name,
      candidate.profile_url,
      candidate.headline,
      candidate.location,
      candidate.current_company,
      candidate.summary,
      candidate.email,
      candidate.phone_number,
      candidate.experience,
      candidate.latest_role,
      candidate.education,
      candidate.skills,
      candidate.language,
      candidate.licenses,
    ];
    await client.query(queryText, values);
  } finally {
    client.release();
  }
}

export async function hasCandidateBeenSent(
  profileUrl: string,
  emails: string[],
  companyName: string,
): Promise<boolean> {
  if (!emails || emails.length === 0) return false;

  const client = await pool.connect();
  try {
    const query = `
      SELECT 1 FROM outreach_history 
      WHERE profile_url = $1 AND company_name = $2 AND recipient_email = ANY($3)
      LIMIT 1
    `;
    const res = await client.query(query, [profileUrl, companyName, emails]);
    return (res.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

/**
 * Records that a candidate was sent to a set of recipients.
 *
 * One statement for every recipient. This was a loop issuing one INSERT per
 * email, so a campaign with M recipients cost M round trips per candidate; the
 * API's copy of this function was converted to an UNNEST some time ago and this
 * one was left behind.
 */
export async function logOutreachSent(
  profileUrl: string,
  emails: string[],
  companyName: string,
  jobName: string,
) {
  if (!emails || emails.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO outreach_history (profile_url, recipient_email, company_name, job_name)
       SELECT $1, e.email, $3, $4
       FROM   unnest($2::text[]) AS e(email)
       ON CONFLICT (profile_url, recipient_email, company_name) DO NOTHING`,
      [profileUrl, emails, companyName, jobName],
    );
  } finally {
    client.release();
  }
}

export async function getSentCandidatesBatch(
  profileUrls: string[],
  emails: string[],
  companyName: string,
): Promise<Set<string>> {
  if (!profileUrls || profileUrls.length === 0 || !emails || emails.length === 0) return new Set();

  const client = await pool.connect();
  try {
    const query = `
            SELECT DISTINCT profile_url FROM outreach_history 
            WHERE profile_url = ANY($1) AND company_name = $2 AND recipient_email = ANY($3)
        `;
    const res = await client.query(query, [profileUrls, companyName, emails]);
    const sentUrls = new Set<string>();
    res.rows.forEach((row) => sentUrls.add(row.profile_url));
    return sentUrls;
  } finally {
    client.release();
  }
}

/** Hard ceiling on getAllCandidateNames, so an omitted limit cannot pull the
 *  whole table into process memory. */
const MAX_CANDIDATE_NAMES = 50_000;

export async function getAllCandidateNames(limit?: number): Promise<string[]> {
  const client = await pool.connect();
  try {
    // None of these predicates is indexable, so this is a sequential scan plus
    // a sort plus a dedup over the whole table however it is written \u2014 but the
    // result set is now bounded. Previously an undefined `limit` produced no
    // LIMIT clause at all and every distinct name was materialised into a JS
    // array. The limit is also a bind parameter now rather than interpolated.
    const query = `
      SELECT DISTINCT c.name
      FROM candidates c
      WHERE c.name IS NOT NULL
        AND c.name != 'Unknown'
        AND length(c.name) > 2
        AND c.name ~ '[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\uAC00-\uD7AF]'
        AND c.name NOT LIKE '%Filtered Candidates%'
        AND c.name NOT LIKE '%Candidate Search%'
        AND c.name NOT LIKE '%Archive%'
        AND c.name NOT LIKE '%.%.%'
      ORDER BY c.name ASC
      LIMIT $1
    `;
    const res = await client.query(query, [Math.min(limit ?? MAX_CANDIDATE_NAMES, MAX_CANDIDATE_NAMES)]);
    return res.rows.map((r) => r.name as string);
  } finally {
    client.release();
  }
}

export default pool;
