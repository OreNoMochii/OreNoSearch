import { describe, it, expect, afterAll } from 'vitest';
import { runIlikeSearch, pool, type IlikeSearchParams } from './repositories/postgres_repo';

/**
 * Search correctness against the live database.
 *
 * Every filter the UI exposes is compared to an independently-written ground
 * truth query. Unit tests can prove a term is classified correctly; only this
 * can prove the number a recruiter reads is the number of people who actually
 * match — which is the question that matters, and the one that was silently
 * wrong for Japanese.
 *
 * SKIPS ITSELF without a database, like integration.test.ts, so CI stays green
 * for the wrong reason rather than red for one.
 *
 *   docker compose up -d
 *   RUN_DB_TESTS=1 npx vitest run src/search_correctness.test.ts --root packages/api
 */
const ENABLED = process.env.RUN_DB_TESTS === '1';
const suite = ENABLED ? describe : describe.skip;

/** The concatenated searchable text, matching SEARCH_BLOB in postgres_repo. */
const BLOB = `(coalesce(name,'')||' '||coalesce(headline,'')||' '||coalesce(latest_role,'')||' '||coalesce(current_company,'')||' '||coalesce(experience,'')||' '||coalesce(summary,''))`;
const TSV = `to_tsvector('english', regexp_replace(${BLOB},'c\\+\\+','cpp_lang','ig'))`;
const TOKYO = `location ILIKE '%Tokyo%'`;

/** A selective English term, so counts stay under the exact-count ceiling. */
const RARE = 'neurosurgeon';
const RARE_TS = `${TSV} @@ to_tsquery('english','''${RARE}''')`;

const base: IlikeSearchParams = {
  andGroups: [],
  must: [],
  should: [],
  mustNot: [],
  locations: ['Tokyo'],
  limit: 5,
};

/** Independently-written ground truth for a WHERE clause. */
async function truth(where: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM candidates_upgraded WHERE ${where} LIMIT 100001) s`,
  );
  return r.rows[0].n as number;
}

suite('search correctness vs ground truth', () => {
  afterAll(async () => {
    await pool.end();
  });

  describe('location', () => {
    it('matches the region', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]] });
      expect(res.total).toBe(await truth(`${TOKYO} AND ${RARE_TS}`));
    }, 120_000);
  });

  describe('boolean keywords — English', () => {
    it('counts an English AND-group term exactly', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]] });
      const expected = await truth(`${TOKYO} AND ${RARE_TS}`);
      expect(res.total).toBe(expected);
      expect(res.totalIsCapped).toBe(false);
    }, 120_000);

    it('ORs terms within a group', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE, 'neurologist']] });
      const expected = await truth(
        `${TOKYO} AND (${RARE_TS} OR ${TSV} @@ to_tsquery('english','''neurologist'''))`,
      );
      expect(res.total).toBe(expected);
    }, 120_000);

    it('ANDs separate groups', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE], ['surgery']] });
      const expected = await truth(
        `${TOKYO} AND ${RARE_TS} AND ${TSV} @@ to_tsquery('english','''surgery''')`,
      );
      expect(res.total).toBe(expected);
    }, 120_000);
  });

  describe('boolean keywords — every Japanese script', () => {
    // Japanese is written in four scripts, usually mixed within one phrase, and
    // all four broke identically before the fix: every term below returned
    // 584,802 — the entire Tokyo region — because the condition never reached
    // the WHERE clause.
    //
    // Kanji and katakana were covered first; hiragana, halfwidth kana and
    // mixed-script terms were verified separately and are pinned here so the
    // coverage matches the claim.
    it.each([
      ['kanji', '看護師'],
      ['kanji', '営業'],
      ['katakana', 'エンジニア'],
      ['katakana', 'コンサルタント'],
      ['hiragana', 'みずほ'],
      ['hiragana', 'ともに'],
      ['kanji + hiragana', '営業活動'],
      ['kanji + hiragana', '話せる'],
      ['halfwidth katakana', 'ｼｽﾃﾑ'],
      // Latin and katakana in one term: classifyTerm must treat the whole
      // thing as a substring rather than tokenising half of it.
      ['mixed Latin + katakana', 'AIエンジニア'],
    ])(
      '%s — %s filters correctly',
      async (_script, term) => {
        const res = await runIlikeSearch({ ...base, andGroups: [[term]], limit: 3 });
        const expected = await truth(`${TOKYO} AND ${BLOB} ILIKE '%${term}%'`);
        const everyoneInTokyo = await truth(TOKYO);

        if (res.totalIsCapped) {
          // Above the ceiling the count is a floor, so it may only understate.
          expect(expected).toBeGreaterThanOrEqual(res.total);
        } else {
          expect(res.total).toBe(expected);
        }

        // The regression guard: it must not be returning the whole region.
        expect(res.total, `${term} returned the entire region`).toBeLessThan(everyoneInTokyo);
        expect(res.hits.length).toBeGreaterThan(0);
      },
      300_000,
    );
  });

  describe('boolean keywords — Japanese', () => {
    // The regression this suite exists for. Each of these previously produced
    // NO condition at all, so the search returned every candidate in Tokyo.
    it.each([['営業'], ['エンジニア'], ['経理'], ['看護師']])(
      'actually filters on %s instead of returning the whole region',
      async (term) => {
        const res = await runIlikeSearch({ ...base, andGroups: [[term]] });
        const expected = await truth(`${TOKYO} AND ${BLOB} ILIKE '%${term}%'`);
        const everyoneInTokyo = await truth(TOKYO);

        // Bounded counts above the ceiling are floors, so compare accordingly.
        if (res.totalIsCapped) {
          expect(expected).toBeGreaterThanOrEqual(res.total);
        } else {
          expect(res.total).toBe(expected);
        }
        // The load-bearing assertion: it is no longer returning the region.
        expect(res.total).toBeLessThan(everyoneInTokyo);
      },
      180_000,
    );

    it('mixes Japanese and English in one OR group', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE, '営業']] });
      const expected = await truth(`${TOKYO} AND (${RARE_TS} OR ${BLOB} ILIKE '%営業%')`);
      if (!res.totalIsCapped) expect(res.total).toBe(expected);
      // A Japanese term must widen an English-only result, never be ignored.
      const englishOnly = await truth(`${TOKYO} AND ${RARE_TS}`);
      expect(res.total).toBeGreaterThan(englishOnly);
    }, 300_000);

    it('ANDs a Japanese group with an English group', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE], ['営業']] });
      const expected = await truth(`${TOKYO} AND ${RARE_TS} AND ${BLOB} ILIKE '%営業%'`);
      expect(res.total).toBe(expected);
    }, 300_000);
  });

  describe('NOT terms', () => {
    it('excludes an English term', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]], mustNot: ['pediatric'] });
      const expected = await truth(
        `${TOKYO} AND ${RARE_TS} AND NOT (${TSV} @@ to_tsquery('english','''pediatric'''))`,
      );
      expect(res.total).toBe(expected);
    }, 120_000);

    it('excludes a Japanese term', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]], mustNot: ['営業'] });
      const expected = await truth(`${TOKYO} AND ${RARE_TS} AND NOT (${BLOB} ILIKE '%営業%')`);
      expect(res.total).toBe(expected);
    }, 120_000);

    it('never widens the result set', async () => {
      const without = await runIlikeSearch({ ...base, andGroups: [[RARE]] });
      const withNot = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        mustNot: ['営業', 'pediatric'],
      });
      expect(withNot.total).toBeLessThanOrEqual(without.total);
    }, 180_000);
  });

  describe('min / max experience', () => {
    it('applies both bounds', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]], minExp: 5, maxExp: 15 });
      const expected = await truth(
        `${TOKYO} AND ${RARE_TS} AND total_experience_months >= 60 AND total_experience_months <= 180`,
      );
      expect(res.total).toBe(expected);
    }, 120_000);

    it('applies a lower bound alone', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]], minExp: 10 });
      expect(res.total).toBe(
        await truth(`${TOKYO} AND ${RARE_TS} AND total_experience_months >= 120`),
      );
    }, 120_000);

    it('narrows monotonically as the floor rises', async () => {
      const low = await runIlikeSearch({ ...base, andGroups: [[RARE]], minExp: 1 });
      const high = await runIlikeSearch({ ...base, andGroups: [[RARE]], minExp: 20 });
      expect(high.total).toBeLessThanOrEqual(low.total);
    }, 180_000);
  });

  describe('exclude companies', () => {
    it('excludes an English company prefix', async () => {
      const res = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        excludeCompanies: ['Tokyo'],
      });
      expect(res.total).toBe(
        await truth(`${TOKYO} AND ${RARE_TS} AND current_company NOT ILIKE 'Tokyo%'`),
      );
    }, 120_000);

    it('excludes a Japanese company prefix', async () => {
      const res = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        excludeCompanies: ['株式会社'],
      });
      expect(res.total).toBe(
        await truth(`${TOKYO} AND ${RARE_TS} AND current_company NOT ILIKE '株式会社%'`),
      );
    }, 120_000);

    it('ANDs several exclusions', async () => {
      const res = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        excludeCompanies: ['株式会社', 'Tokyo'],
      });
      expect(res.total).toBe(
        await truth(
          `${TOKYO} AND ${RARE_TS} AND current_company NOT ILIKE '株式会社%' AND current_company NOT ILIKE 'Tokyo%'`,
        ),
      );
    }, 120_000);
  });

  describe('current role keywords', () => {
    it('matches an English keyword', async () => {
      const res = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        currentRoleKeywords: ['Director'],
      });
      expect(res.total).toBe(
        await truth(`${TOKYO} AND ${RARE_TS} AND (latest_role ILIKE '%Director%')`),
      );
    }, 120_000);

    it('matches a Japanese keyword', async () => {
      const res = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        currentRoleKeywords: ['部長'],
      });
      expect(res.total).toBe(
        await truth(`${TOKYO} AND ${RARE_TS} AND (latest_role ILIKE '%部長%')`),
      );
    }, 120_000);

    it('ORs comma-separated keywords across both languages', async () => {
      // The UI splits on commas and passes an array; the array is OR'd.
      const res = await runIlikeSearch({
        ...base,
        andGroups: [[RARE]],
        currentRoleKeywords: ['部長', 'Director', '課長'],
      });
      expect(res.total).toBe(
        await truth(
          `${TOKYO} AND ${RARE_TS} AND (latest_role ILIKE '%部長%' OR latest_role ILIKE '%Director%' OR latest_role ILIKE '%課長%')`,
        ),
      );
    }, 120_000);
  });

  describe('count honesty', () => {
    it('reports a selective count as exact', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [[RARE]] });
      expect(res.totalIsCapped).toBe(false);
      expect(res.total).toBeLessThan(10_000);
    }, 120_000);

    it('flags a broad count as a floor rather than asserting it', async () => {
      // Above the exact-count ceiling the figure comes from the planner, whose
      // estimates on this table run up to ~80x over and ~45% under. It must not
      // be presented as a count.
      const res = await runIlikeSearch({ ...base, andGroups: [['engineer']] });
      expect(res.total).toBeGreaterThanOrEqual(10_000);
      expect(res.totalIsCapped).toBe(true);
    }, 180_000);
  });

  describe('hits agree with the count', () => {
    it('returns rows that genuinely contain the Japanese term', async () => {
      const res = await runIlikeSearch({ ...base, andGroups: [['営業']], limit: 10 });
      expect(res.hits.length).toBeGreaterThan(0);
      for (const hit of res.hits) {
        const blob = [
          hit.full_name,
          hit.ai_latest_role,
          hit.ai_latest_company,
          hit.resume_text_excerpt,
          hit.candidate_summary,
        ]
          .filter(Boolean)
          .join(' ');
        expect(blob, `${hit.folder_id} does not contain 営業`).toContain('営業');
      }
    }, 300_000);
  });
});
