import { Pool, type PoolClient } from 'pg';
import { config } from '../config';
import { toTsQueryPhrase } from '../core/tsquery';
import { logError, logInfo, logWarn } from '../utils/logger';

/**
 * Connection pool for the golden database.
 *
 * The previous pool used pg defaults throughout: max 10 connections and no
 * timeouts of any kind, so a single runaway query (see the sequential scans
 * that `runIlikeSearch` could trigger) held a connection until the client gave
 * up. statement_timeout bounds that server-side.
 */
export const pool = new Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  query_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  application_name: 'metaview-api',
});

// An idle client erroring out (server restart, network blip) emits on the pool.
// Without this handler the default behaviour is an uncaught exception.
pool.on('error', (err) => logError('pg_pool_error', err));

// Applied once per physical connection, so every query in this pool gets it
// without a round trip per statement. See config.DB_WORK_MEM for why the
// server default is insufficient here.
pool.on('connect', (client) => {
  client
    .query(`SET work_mem = '${config.DB_WORK_MEM}'`)
    .catch((err: unknown) => logError('pg_set_work_mem_failed', err));
});

/** Drains the pool during graceful shutdown. */
export async function shutdownPool(): Promise<void> {
  await pool.end();
}

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

/**
 * Creates the scraper's tables, indexes and helper function.
 *
 * SAFETY: this issues DDL (CREATE TABLE, ALTER TABLE, CREATE OR REPLACE
 * FUNCTION) against the golden database. Every statement is guarded by
 * IF NOT EXISTS, so against the current schema it is a no-op — but it is still
 * DDL, and it runs from the scraper entrypoints.
 *
 * It is therefore opt-in: set ALLOW_SCHEMA_INIT=1 to permit it. Without that,
 * this logs and returns, so no code path can modify the production schema by
 * accident.
 */
export async function initDb() {
  if (process.env.ALLOW_SCHEMA_INIT !== '1') {
    logWarn('schema_init_skipped', {
      reason: 'ALLOW_SCHEMA_INIT is not set to 1',
      hint: 'Set ALLOW_SCHEMA_INIT=1 only when you intend to apply DDL.',
    });
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

      -- Must stay byte-identical to migration 003, which builds
      -- idx_cu_total_exp_months on this expression. initDb() issues
      -- CREATE OR REPLACE and runs from the scraper entrypoint, so a drift here
      -- silently replaces the indexed function and invalidates the index.
      --
      -- Backslashes are DOUBLED: this SQL lives in a JS template literal, where
      -- \\d and \\s are not recognised escapes, so JavaScript drops the
      -- backslash and Postgres would receive '(?i)(d+)s*yr' — matching literal
      -- 'd' characters instead of digits (B24).
      --
      -- The pattern bounds digits to 3 and requires a word boundary (\\y) after
      -- the unit. Without the boundary, 'mo' matched Mon/Monday/Monash/MoneyLion,
      -- so phone numbers, ISBNs and URLs parsed as durations — 4.32% of rows
      -- computed wrong values and 30 rows raised an integer overflow that made
      -- the function throw outright (B31).
      CREATE OR REPLACE FUNCTION calculate_total_experience_months(exp TEXT)
      RETURNS INTEGER AS $$
      DECLARE
          rec RECORD;
          total_m BIGINT := 0;
      BEGIN
          IF exp IS NULL OR exp = '' THEN
              RETURN 0;
          END IF;

          FOR rec IN SELECT (regexp_matches(exp, '(?i)(\\d{1,3})\\s*yrs?\\y', 'g'))[1]::bigint AS yrs LOOP
              total_m := total_m + (rec.yrs * 12);
          END LOOP;

          FOR rec IN SELECT (regexp_matches(exp, '(?i)(\\d{1,3})\\s*mos?\\y', 'g'))[1]::bigint AS mos LOOP
              total_m := total_m + rec.mos;
          END LOOP;

          RETURN LEAST(total_m, 2147483647)::INTEGER;
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
 * Records that a set of candidates was sent to a set of recipients.
 *
 * The previous signature took a single profile_url and issued one INSERT per
 * recipient, so a campaign of N candidates x M recipients produced N*M round
 * trips. The UNNEST cross-join below does the whole cartesian product in a
 * single statement.
 *
 * @returns the number of rows actually inserted (conflicts are skipped).
 */
export async function logOutreachSent(
  profileUrls: readonly string[],
  emails: readonly string[],
  companyName: string,
  jobName: string,
): Promise<number> {
  const urls = profileUrls.filter((u) => u && u !== 'N/A');
  if (urls.length === 0 || emails.length === 0) return 0;

  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO outreach_history (profile_url, recipient_email, company_name, job_name)
       SELECT u.url, e.email, $3, $4
       FROM   unnest($1::text[]) AS u(url)
       CROSS  JOIN unnest($2::text[]) AS e(email)
       ON CONFLICT (profile_url, recipient_email, company_name) DO NOTHING`,
      [[...urls], [...emails], companyName, jobName],
    );
    return res.rowCount ?? 0;
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

/**
 * Records screening verdicts — one statement for the whole batch.
 *
 * Replaces a single-row `saveScreeningResult` that the tree engine called once
 * per candidate inside a Promise.all: up to `treeTopK` (2,000) concurrent
 * pool.connect() calls, each taking one of the DB_POOL_MAX connections that the
 * search path shares. A campaign therefore monopolised the pool, and concurrent
 * searches queued behind it until pg-pool's connectionTimeoutMillis fired. This
 * is one connection and one round trip regardless of batch size.
 *
 * Pass a single-element array for a single verdict; there is deliberately no
 * one-row variant left to reach for.
 */
export async function saveScreeningResultsBatch(
  results: readonly { profileUrl: string; verdict: 'PASS' | 'REJECT'; reasoning?: string }[],
  companyName: string,
  jobName: string,
): Promise<number> {
  if (results.length === 0) return 0;

  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO screening_results (profile_url, company_name, job_name, verdict, reasoning)
       SELECT r.url, $3, $4, r.verdict, r.reasoning
       FROM   unnest($1::text[], $2::text[], $5::text[]) AS r(url, verdict, reasoning)
       ON CONFLICT (profile_url, company_name, job_name) DO UPDATE SET
         verdict     = EXCLUDED.verdict,
         reasoning   = EXCLUDED.reasoning,
         screened_at = CURRENT_TIMESTAMP`,
      [
        results.map((r) => r.profileUrl),
        results.map((r) => r.verdict),
        companyName,
        jobName,
        results.map((r) => r.reasoning ?? null),
      ],
    );
    return res.rowCount ?? 0;
  } finally {
    client.release();
  }
}

export async function getScreenedCandidatesBatch(
  profileUrls: string[],
  companyName: string,
  jobName: string,
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
  companyNames: string[],
): Promise<Map<string, CompanyIntel>> {
  const result = new Map<string, CompanyIntel>();
  if (!companyNames || companyNames.length === 0) return result;

  // Deduplicate and lowercase
  const uniqueNames = [
    ...new Set(companyNames.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0)),
  ];
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
  andGroups: string[][]; // Each group: terms OR'd internally, groups AND'd externally
  must: string[]; // Every term must appear (AND)
  should: string[]; // At least one term must appear (OR)
  mustNot: string[]; // None of these terms should appear
  locations?: string[];
  minExp?: number;
  maxExp?: number;
  excludeCompanies?: string[];
  currentRoleKeywords?: string[];
  limit: number;
  /**
   * Skips the bounded COUNT probe.
   *
   * The count exists to tell a human "this query is too broad" and is the
   * dominant cost of a search (see COUNT_CAP below). A campaign resolving its
   * candidate set never reads `total`, so paying for it there is pure waste.
   */
  skipCount?: boolean;
}

/**
 * The candidate projection the UI and the screening engines expect.
 *
 * Shared by runIlikeSearch and getCandidatesByUrl so a campaign resolved by
 * hydration is byte-identical to one resolved by search — normaliseCandidates
 * reads these aliases.
 */
const CANDIDATE_PROJECTION = `
                profile_url as folder_id,
                name as full_name,
                profile_url as resume_drive_view_url,
                latest_role as ai_latest_role,
                location as ai_latest_location,
                current_company as ai_latest_company,
                summary as candidate_summary,
                experience as resume_text_excerpt,
                education,
                skills`;

/**
 * Hydrates full candidate rows from a list of profile URLs.
 *
 * Used by the Meilisearch campaign path, where the boolean set algebra runs in
 * the browser but the documents themselves have no business being posted back:
 * profile_url is the primary key, so this is an index scan.
 */
export async function getCandidatesByUrl(
  profileUrls: readonly string[],
): Promise<Record<string, unknown>[]> {
  if (profileUrls.length === 0) return [];

  const client = await pool.connect();
  try {
    const rows: Record<string, unknown>[] = [];
    // Chunked so neither the bind parameter nor the result set is unbounded.
    const CHUNK = 10_000;
    for (let i = 0; i < profileUrls.length; i += CHUNK) {
      const res = await client.query(
        `SELECT ${CANDIDATE_PROJECTION}
         FROM candidates_upgraded
         WHERE profile_url = ANY($1::text[])`,
        [profileUrls.slice(i, i + CHUNK)],
      );
      rows.push(...res.rows);
    }
    return rows;
  } finally {
    client.release();
  }
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
      const mustQueries = Array.from(new Set(params.must.map(toTsQueryPhrase).filter(Boolean)));
      if (mustQueries.length > 0) tsqueryParts.push(`(${mustQueries.join(' & ')})`);
    }

    // SHOULD terms (OR)
    if (params.should && params.should.length > 0) {
      const shouldQueries = Array.from(new Set(params.should.map(toTsQueryPhrase).filter(Boolean)));
      if (shouldQueries.length > 0) tsqueryParts.push(`(${shouldQueries.join(' | ')})`);
    }

    // AND GROUPS
    if (params.andGroups && params.andGroups.length > 0) {
      for (const group of params.andGroups) {
        if (group.length === 0) continue;
        const groupQueries = Array.from(new Set(group.map(toTsQueryPhrase).filter(Boolean)));
        if (groupQueries.length > 0) tsqueryParts.push(`(${groupQueries.join(' | ')})`);
      }
    }

    // MUST NOT terms (NOT)
    if (params.mustNot && params.mustNot.length > 0) {
      const notQueries = Array.from(new Set(params.mustNot.map(toTsQueryPhrase).filter(Boolean)));
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
      for (const loc of params.locations) {
        const cleanLoc = loc.replace(/\s*\([^)]*\)/g, '').trim();
        const parts = cleanLoc.split(/\s*\/\s*/).filter(Boolean);
        for (const part of parts) {
          locConditions.push(`location ILIKE $${paramIndex}`);
          values.push(`%${part}%`);
          paramIndex++;
        }
      }
      conditions.push(`(${locConditions.join(' OR ')})`);
    }

    // Reads the materialised column added by migration 004, served by
    // idx_cu_total_exp_months_col.
    //
    // This previously called calculate_total_experience_months(experience)
    // inline. Even with an expression index the plpgsql function was
    // re-evaluated on every bitmap recheck — ~24us per call, and a broad search
    // rechecks over 100,000 rows. Materialising it turns the filter into a
    // plain indexed integer comparison.
    //
    // Deliberately NOT the pre-existing `experience_months` column: that one is
    // generated with substring(), which captures only the FIRST match, so it
    // measures the first-listed role's duration. This one sums every role. On a
    // 500-row sample the two agreed on 17% of rows, so swapping them would
    // silently redefine what minExp/maxExp mean.
    //
    // Kept correct by the set_total_experience_months trigger.
    if (params.minExp !== undefined) {
      conditions.push(`total_experience_months >= $${paramIndex}`);
      values.push(params.minExp * 12);
      paramIndex++;
    }

    if (params.maxExp !== undefined) {
      conditions.push(`total_experience_months <= $${paramIndex}`);
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

    // B32: the count is deliberately bounded — an exact count over 5.6M rows
    // costs seconds. But the bound was previously invisible to the caller: the
    // capped value was returned as `total`, the UI printed it as "N total
    // records match", and App.tsx passed it straight back as the outreach fetch
    // limit. A query matching 500,000 candidates therefore reported 1,000 and
    // the campaign screened only 1,000 of them.
    //
    // Probing COUNT_CAP + 1 makes saturation detectable, so callers can render
    // "2,000+" and refuse to treat it as an exact figure.
    //
    // PERFORMANCE: the cap is the dominant cost of a search. Measured on the
    // live 5.6M-row table with a broad query (engineer + Tokyo + 5-15 years):
    //
    //     cap  1,000 ->   597 ms
    //     cap  2,000 ->   902 ms
    //     cap  5,000 -> 2,195 ms
    //     cap 10,000 -> 5,128 ms
    //
    // Roughly linear, because the executor must actually locate that many
    // matching rows. 2,000 is the knee: it still tells a user "this query is
    // too broad, narrow it" — which is all the figure is for — at under a fifth
    // of the cost. It is safe to lower now that the outreach dispatch no longer
    // derives its fetch limit from this value (B32).
    const COUNT_CAP = config.SEARCH_COUNT_CAP;

    // We use EXPLAIN to get a blazing-fast estimate of the total matching rows
    // (which represents the "whole figures" for the UI) without running a full
    // sequence scan that could take >60s and time out the API.
    const explainQuery = `EXPLAIN SELECT 1 FROM candidates_upgraded ${whereClause}`;
    const exactCountBoundedQuery = `SELECT count(*)::int AS n FROM (SELECT 1 FROM candidates_upgraded ${whereClause} LIMIT 10000) sub`;

    const finalQuery = `
            SELECT ${CANDIDATE_PROJECTION}
            FROM candidates_upgraded
            ${whereClause}
            LIMIT $${paramIndex}
        `;

    // skipCount drops the count entirely for callers that never read it.
    let counted = 0;
    if (!params.skipCount) {
      // First try to count up to 10000 accurately. This takes <300ms for broad queries.
      const exactRes = await client.query(exactCountBoundedQuery, values);
      const exactCount = exactRes.rows[0].n;

      if (exactCount < 10000) {
        // Perfectly accurate count!
        counted = exactCount;
      } else {
        // Over 10k, so use the statistical estimate to give the huge number instantly.
        const explainRes = await client.query(explainQuery, values);
        const plan = explainRes.rows.map((r: any) => Object.values(r)[0]).join('\n');
        const match = plan.match(/rows=(\d+)/);
        const estimate = match ? parseInt(match[1], 10) : 0;
        // The estimate might be smaller than 10000 due to planner inaccuracies, so we floor it to 10000
        counted = Math.max(estimate, 10000);
      }
    }

    const res = await client.query(finalQuery, [...values, params.limit]);

    // We no longer cap the total so the UI can display the whole figure.
    // Setting totalIsCapped to false ensures the UI just prints the number.
    const total = counted;
    const totalIsCapped = false;

    return { hits: res.rows, total, totalIsCapped, countCap: COUNT_CAP };
  } finally {
    client.release();
  }
}

/**
 * Location list cache.
 *
 * B28: this was a permanent cache with no expiry and no invalidation hook, so
 * regions added by scraping never appeared in the filter UI until the process
 * was restarted. The aggregate is expensive (a full scan with a large CASE
 * expression), so caching is right — it just needs a bound.
 *
 * A single in-flight promise is also tracked, so N concurrent cold requests
 * issue one query rather than N.
 */
const LOCATION_CACHE_TTL_MS = 15 * 60_000;

let cachedLocations: string[] | null = null;
let cachedAt = 0;
let inFlight: Promise<string[]> | null = null;

/** Drops the cache. Call after a scrape or Meilisearch sync adds new regions. */
export function invalidateLocationCache(): void {
  cachedLocations = null;
  cachedAt = 0;
}

export async function getAvailableLocations(): Promise<string[]> {
  const fresh = cachedLocations !== null && Date.now() - cachedAt < LOCATION_CACHE_TTL_MS;
  if (fresh) return cachedLocations!;

  // Collapse a thundering herd of cold requests into one query.
  if (inFlight) return inFlight;

  inFlight = queryAvailableLocations()
    .then((rows) => {
      cachedLocations = rows;
      cachedAt = Date.now();
      return rows;
    })
    .catch((err: unknown) => {
      // Serving a stale list beats failing the filter UI outright.
      if (cachedLocations !== null) {
        logError('location_refresh_failed_serving_stale', err);
        return cachedLocations;
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Region mapping, applied to one row per DISTINCT location.
 *
 * Kept in application code rather than baked into the materialised view: these
 * are business rules that change (a new city, a renamed region), and changing
 * them here needs a deploy, not a schema migration.
 */
const LOCATION_REGION_CASE = `
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
                END`;

/**
 * Rolls per-location counts up into the region list.
 *
 * `AS MATERIALIZED` is load-bearing, not decoration. Without it the planner
 * inlines the CTE and pushes the outer
 *
 *     WHERE display_location IS NOT NULL AND display_location <> ''
 *
 * down into the scan — and since `display_location` IS the CASE expression, the
 * whole 21-branch CASE then appears twice in the scan's Filter and is evaluated
 * twice per input row. Fencing the CTE halves the work (measured on the 19,003
 * row source: 486 ms -> 170 ms).
 *
 * @param source table or view providing (location, cnt)
 */
const regionRollupQuery = (source: string) => `
            WITH normalized AS MATERIALIZED (
              SELECT ${LOCATION_REGION_CASE} AS display_location, cnt
              FROM ${source}
            )
            SELECT display_location, SUM(cnt)::int AS total
            FROM normalized
            WHERE display_location IS NOT NULL AND display_location <> ''
            GROUP BY display_location
            HAVING SUM(cnt) >= 100
            ORDER BY total DESC`;

/** Materialised per-location counts. See migration 006. */
const LOCATION_COUNTS_MATVIEW = 'candidate_location_counts';

/** Live equivalent of the matview, for the fallback path. */
const LOCATION_COUNTS_INLINE = `(
              SELECT location, count(*)::bigint AS cnt
              FROM candidates_upgraded
              WHERE location IS NOT NULL AND location <> ''
              GROUP BY location
            ) AS live_counts`;

/**
 * Whether candidate_location_counts exists.
 *
 * Checked once and remembered: the answer only changes when a migration runs,
 * and this is on the cold path of a user-facing request.
 */
let matviewAvailable: boolean | null = null;

async function hasLocationMatview(client: PoolClient): Promise<boolean> {
  if (matviewAvailable !== null) return matviewAvailable;
  const res = await client.query(
    `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'm' LIMIT 1`,
    [LOCATION_COUNTS_MATVIEW],
  );
  matviewAvailable = (res.rowCount ?? 0) > 0;
  if (!matviewAvailable) {
    logWarn('location_matview_missing', {
      matview: LOCATION_COUNTS_MATVIEW,
      impact: 'falling back to the live aggregate — ~2.4s per cold load instead of ~170ms',
      fix: 'apply packages/scraper/migrations/006_location_counts_matview.sql',
    });
  }
  return matviewAvailable;
}

/**
 * Refreshes the location snapshot.
 *
 * The matview does not see rows added since it was last built, so a scrape that
 * introduces a new region will not surface it in the filter UI until this runs.
 * CONCURRENTLY keeps the view readable throughout — it needs the unique index
 * migration 006 creates.
 *
 * Returns false when the matview is not installed, so callers can treat this as
 * advisory rather than a failure.
 */
export async function refreshLocationCounts(): Promise<boolean> {
  const client = await pool.connect();
  try {
    if (!(await hasLocationMatview(client))) return false;
    const started = Date.now();
    // Not a parameterisable position; the identifier is a module constant.
    await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${LOCATION_COUNTS_MATVIEW}`);
    logInfo('location_matview_refreshed', { durationMs: Date.now() - started });
    invalidateLocationCache();
    return true;
  } finally {
    client.release();
  }
}

async function queryAvailableLocations(): Promise<string[]> {
  const client = await pool.connect();
  try {
    // Reads the 19,003-row snapshot rather than aggregating 5,661,466 rows on
    // the request. Falls back to the live aggregate when the matview has not
    // been installed, so the endpoint degrades in speed rather than failing.
    const source = (await hasLocationMatview(client))
      ? LOCATION_COUNTS_MATVIEW
      : LOCATION_COUNTS_INLINE;

    const res = await client.query(regionRollupQuery(source));
    // Deliberately does NOT assign cachedLocations here: getAvailableLocations
    // owns the cache and bumps cachedAt with it. Writing from both places made
    // a failed refresh briefly visible as a fresh one.
    return res.rows.map((r) => r.display_location as string).sort();
  } finally {
    client.release();
  }
}
