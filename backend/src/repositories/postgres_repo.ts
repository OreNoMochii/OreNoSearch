import { Pool } from 'pg';
import dotenv from 'dotenv';

import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') }); // Adjust relative path based on execution context

export const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
});

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
      
      -- Schema migration for existing tables: add summary if missing
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

      CREATE TABLE IF NOT EXISTS screening_results (
        id SERIAL PRIMARY KEY,
        profile_url VARCHAR(500) NOT NULL,
        company_name VARCHAR(255) NOT NULL,
        job_name VARCHAR(255) NOT NULL,
        verdict VARCHAR(20) NOT NULL,
        reasoning TEXT,
        screened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(profile_url, company_name, job_name)
      );
      CREATE INDEX IF NOT EXISTS idx_screening_results_lookup ON screening_results(company_name, job_name);

      CREATE OR REPLACE FUNCTION calculate_total_experience_months(exp TEXT)
      RETURNS INTEGER AS $$
      DECLARE
          rec RECORD;
          total_m INTEGER := 0;
      BEGIN
          IF exp IS NULL OR exp = '' THEN
              RETURN 0;
          END IF;
          
          FOR rec IN SELECT (regexp_matches(exp, '(?i)(\d+)\s*yr[s]?', 'g'))[1]::int AS yrs LOOP
              total_m := total_m + (rec.yrs * 12);
          END LOOP;

          FOR rec IN SELECT (regexp_matches(exp, '(?i)(\d+)\s*mo[s]?', 'g'))[1]::int AS mos LOOP
              total_m := total_m + rec.mos;
          END LOOP;

          RETURN total_m;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `;
    await client.query(queryText);
    console.log('Database initialized successfully.');
  } finally {
    client.release();
  }
}

export async function saveCandidate(candidate: Candidate) {
  const client = await pool.connect();
  try {
    const queryText = `
      INSERT INTO candidates (
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
        email = EXCLUDED.email,
        phone_number = EXCLUDED.phone_number,
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
      candidate.licenses
    ];
    await client.query(queryText, values);
  } finally {
    client.release();
  }
}

export async function hasCandidateBeenSent(profileUrl: string, emails: string[], companyName: string): Promise<boolean> {
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

export async function logOutreachSent(profileUrl: string, emails: string[], companyName: string, jobName: string) {
  if (!emails || emails.length === 0) return;

  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO outreach_history (profile_url, recipient_email, company_name, job_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (profile_url, recipient_email, company_name) DO NOTHING
    `;
    for (const email of emails) {
      await client.query(query, [profileUrl, email, companyName, jobName]);
    }
  } finally {
    client.release();
  }
}

export async function getSentCandidatesBatch(profileUrls: string[], emails: string[], companyName: string): Promise<Set<string>> {
    if (!profileUrls || profileUrls.length === 0 || !emails || emails.length === 0) return new Set();
    
    const client = await pool.connect();
    try {
        const query = `
            SELECT DISTINCT profile_url FROM outreach_history 
            WHERE profile_url = ANY($1) AND company_name = $2 AND recipient_email = ANY($3)
        `;
        const res = await client.query(query, [profileUrls, companyName, emails]);
        const sentUrls = new Set<string>();
        res.rows.forEach(row => sentUrls.add(row.profile_url));
        return sentUrls;
    } finally {
        client.release();
    }
}

export async function saveScreeningResult(
    profileUrl: string, companyName: string, jobName: string,
    verdict: 'PASS' | 'REJECT', reasoning?: string
) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO screening_results (profile_url, company_name, job_name, verdict, reasoning)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (profile_url, company_name, job_name) DO UPDATE SET
                verdict = EXCLUDED.verdict,
                reasoning = EXCLUDED.reasoning,
                screened_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [profileUrl, companyName, jobName, verdict, reasoning || null]);
    } finally {
        client.release();
    }
}

export async function getScreenedCandidatesBatch(
    profileUrls: string[], companyName: string, jobName: string
): Promise<Map<string, 'PASS' | 'REJECT'>> {
    const result = new Map<string, 'PASS' | 'REJECT'>();
    if (!profileUrls || profileUrls.length === 0) return result;

    const client = await pool.connect();
    try {
        const query = `
            SELECT profile_url, verdict FROM screening_results
            WHERE profile_url = ANY($1) AND company_name = $2 AND job_name = $3
        `;
        const res = await client.query(query, [profileUrls, companyName, jobName]);
        for (const row of res.rows) {
            result.set(row.profile_url, row.verdict as 'PASS' | 'REJECT');
        }
        return result;
    } finally {
        client.release();
    }
}

export interface CompanyIntel {
    name: string;
    company_type: string;
    size_band: string;
    reputation: string;
    compensation: string;
    flight_risk: string;
    flight_note: string;
}

/**
 * Batch lookup company intel for a list of candidate company names.
 * Uses case-insensitive matching against the companies_analyzed table.
 * Returns a Map keyed by lowercased company name for O(1) lookups.
 */
export async function getCompanyIntelBatch(
    companyNames: string[]
): Promise<Map<string, CompanyIntel>> {
    const result = new Map<string, CompanyIntel>();
    if (!companyNames || companyNames.length === 0) return result;

    // Deduplicate and lowercase
    const uniqueNames = [...new Set(companyNames.map(n => n.trim().toLowerCase()).filter(n => n.length > 0))];
    if (uniqueNames.length === 0) return result;

    const client = await pool.connect();
    try {
        const query = `
            SELECT name, company_type, size_band, reputation, compensation, flight_risk, flight_note
            FROM companies_analyzed
            WHERE lower(name) = ANY($1)
        `;
        const res = await client.query(query, [uniqueNames]);
        for (const row of res.rows) {
            result.set(row.name.trim().toLowerCase(), {
                name: row.name,
                company_type: row.company_type || 'Unknown',
                size_band: row.size_band || 'Unknown',
                reputation: row.reputation || 'Unknown',
                compensation: row.compensation || 'Unknown',
                flight_risk: row.flight_risk || 'Unknown',
                flight_note: row.flight_note || '',
            });
        }
        return result;
    } finally {
        client.release();
    }
}

export interface IlikeSearchParams {
    andGroups: string[][];   // Each group: terms OR'd internally, groups AND'd externally
    must: string[];          // Every term must appear (AND)
    should: string[];        // At least one term must appear (OR)
    mustNot: string[];       // None of these terms should appear
    locations?: string[];
    minExp?: number;
    maxExp?: number;
    excludeCompanies?: string[];
    currentRoleKeywords?: string[];
    limit: number;
}

function escapeTsQueryTerm(term: string): string {
    let cleanTerm = term.replace(/c\+\+/ig, 'cpp_lang');
    const parts = cleanTerm.trim().split(/\s+/);
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) return '';
    return parts.map(p => `'${p.replace(/'/g, "''")}'`).join(' <-> ');
}

export async function runIlikeSearch(params: IlikeSearchParams) {
    const client = await pool.connect();
    try {
        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        const tsqueryParts: string[] = [];

        // MUST terms (AND)
        if (params.must && params.must.length > 0) {
            const mustQueries = params.must.map(escapeTsQueryTerm).filter(Boolean);
            if (mustQueries.length > 0) tsqueryParts.push(`(${mustQueries.join(' & ')})`);
        }

        // SHOULD terms (OR)
        if (params.should && params.should.length > 0) {
            const shouldQueries = params.should.map(escapeTsQueryTerm).filter(Boolean);
            if (shouldQueries.length > 0) tsqueryParts.push(`(${shouldQueries.join(' | ')})`);
        }

        // AND GROUPS
        if (params.andGroups && params.andGroups.length > 0) {
            for (const group of params.andGroups) {
                if (group.length === 0) continue;
                const groupQueries = group.map(escapeTsQueryTerm).filter(Boolean);
                if (groupQueries.length > 0) tsqueryParts.push(`(${groupQueries.join(' | ')})`);
            }
        }

        // MUST NOT terms (NOT)
        if (params.mustNot && params.mustNot.length > 0) {
            const notQueries = params.mustNot.map(escapeTsQueryTerm).filter(Boolean);
            if (notQueries.length > 0) tsqueryParts.push(`!(${notQueries.join(' | ')})`);
        }

        if (tsqueryParts.length > 0) {
            const finalTsQueryStr = tsqueryParts.join(' & ');
            conditions.push(`
                to_tsvector('english', 
                  regexp_replace(
                    coalesce(name, '') || ' ' || 
                    coalesce(headline, '') || ' ' || 
                    coalesce(latest_role, '') || ' ' || 
                    coalesce(current_company, '') || ' ' || 
                    coalesce(experience, '') || ' ' || 
                    coalesce(summary, ''),
                    'c\\+\\+', 'cpp_lang', 'ig'
                  )
                ) @@ to_tsquery('english', $${paramIndex})
            `);
            values.push(finalTsQueryStr);
            paramIndex++;
        }

        // Location filter (ILIKE for region-level matching)
        if (params.locations && params.locations.length > 0) {
            const locConditions: string[] = [];
            const locValues: string[] = [];
            let locIdx = 1;
            for (const loc of params.locations) {
                let cleanLoc = loc.replace(/\s*\([^)]*\)/g, '').trim();
                const parts = cleanLoc.split(/\s*\/\s*/).filter(Boolean);
                for (const part of parts) {
                    locConditions.push(`location ILIKE $${paramIndex}`);
                    values.push(`%${part}%`);
                    paramIndex++;

                    locValues.push(`%${part}%`);
                    locIdx++;
                }
            }
            conditions.push(`(${locConditions.join(' OR ')})`);
        }

        if (params.minExp !== undefined) {
            conditions.push(`calculate_total_experience_months(experience) >= $${paramIndex}`);
            values.push(params.minExp * 12);
            paramIndex++;
        }

        if (params.maxExp !== undefined) {
            conditions.push(`calculate_total_experience_months(experience) <= $${paramIndex}`);
            values.push(params.maxExp * 12);
            paramIndex++;
        }

        if (params.excludeCompanies && params.excludeCompanies.length > 0) {
            const excludeConditions = params.excludeCompanies.map(() => {
                const clause = `current_company NOT ILIKE $${paramIndex}`;
                paramIndex++;
                return clause;
            });
            conditions.push(`(${excludeConditions.join(' AND ')})`);
            for (const comp of params.excludeCompanies) {
                values.push(`${comp}%`);
            }
        }

        if (params.currentRoleKeywords && params.currentRoleKeywords.length > 0) {
            const roleConditions = params.currentRoleKeywords.map(() => {
                const clause = `latest_role ILIKE $${paramIndex}`;
                paramIndex++;
                return clause;
            });
            conditions.push(`(${roleConditions.join(' OR ')})`);
            for (const kw of params.currentRoleKeywords) {
                values.push(`%${kw}%`);
            }
        }

        let whereClause = '';
        if (conditions.length > 0) {
            whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        const finalQuery = `
            SELECT 
                profile_url as folder_id,
                name as full_name, 
                profile_url as resume_drive_view_url, 
                latest_role as ai_latest_role, 
                location as ai_latest_location, 
                current_company as ai_latest_company, 
                summary as candidate_summary,
                experience as resume_text_excerpt, 
                education, 
                skills
            FROM candidates_upgraded
            ${whereClause}
            LIMIT $${paramIndex}
        `;

        const finalValues = [...values, params.limit];
        const res = await client.query(finalQuery, finalValues);
        
        // Also get total count
        const countQuery = `
            SELECT count(*) as total
            FROM candidates_upgraded
            ${whereClause}
        `;
        const countRes = await client.query(countQuery, values);
        
        return {
            hits: res.rows,
            total: parseInt(countRes.rows[0].total)
        };
    } finally {
        client.release();
    }
}

export async function getAvailableLocations(): Promise<string[]> {
    const client = await pool.connect();
    try {
        // Consolidated top-level regions (Tokyo, Kanagawa, Osaka, Singapore, etc.)
        const query = `
            WITH normalized AS (
              SELECT 
                CASE
                  WHEN location ILIKE '%tokyo%' THEN 'Tokyo'
                  WHEN location ILIKE '%kanagawa%' OR location ILIKE '%yokohama%' OR location ILIKE '%kawasaki%' OR location ILIKE '%fujisawa%' THEN 'Kanagawa'
                  WHEN location ILIKE '%osaka%' THEN 'Osaka'
                  WHEN location ILIKE '%chiba%' THEN 'Chiba'
                  WHEN location ILIKE '%saitama%' THEN 'Saitama'
                  WHEN location ILIKE '%aichi%' OR location ILIKE '%nagoya%' THEN 'Aichi'
                  WHEN location ILIKE '%kyoto%' THEN 'Kyoto'
                  WHEN location ILIKE '%hyogo%' OR location ILIKE '%kobe%' THEN 'Hyogo'
                  WHEN location ILIKE '%hokkaido%' OR location ILIKE '%sapporo%' THEN 'Hokkaido'
                  WHEN location ILIKE '%fukuoka%' THEN 'Fukuoka'
                  WHEN location ILIKE '%hiroshima%' THEN 'Hiroshima'
                  WHEN location ILIKE '%singapore%' THEN 'Singapore'
                  WHEN location ILIKE '%kuala lumpur%' OR location ILIKE '%selangor%' THEN 'Kuala Lumpur / Selangor'
                  WHEN location ILIKE '%penang%' THEN 'Penang'
                  WHEN location ILIKE '%johor%' THEN 'Johor'
                  WHEN location ILIKE '%ho chi minh%' THEN 'Ho Chi Minh City'
                  WHEN location ILIKE '%hanoi%' THEN 'Hanoi'
                  WHEN location ILIKE '%da nang%' THEN 'Da Nang'
                  WHEN location ILIKE '%vietnam%' THEN 'Vietnam'
                  WHEN location ILIKE '%malaysia%' THEN 'Malaysia'
                  WHEN location ILIKE '%japan%' THEN 'Japan'
                  ELSE trim(split_part(location, ',', 1))
                END AS display_location,
                count(*) as cnt
              FROM candidates_upgraded
              WHERE location IS NOT NULL AND location != ''
              GROUP BY location
            )
            SELECT display_location, SUM(cnt)::int as total
            FROM normalized
            WHERE display_location IS NOT NULL AND display_location != ''
            GROUP BY display_location
            HAVING SUM(cnt) >= 100
            ORDER BY total DESC;
        `;
        const res = await client.query(query);
        return res.rows.map(r => r.display_location).sort();
    } finally {
        client.release();
    }
}

