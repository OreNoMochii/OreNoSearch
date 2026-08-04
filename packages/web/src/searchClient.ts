/**
 * searchClient.ts — browser-side search.
 *
 * SECURITY (B2): this module no longer holds a Meilisearch key of any kind.
 * It previously embedded the **master** key as a string literal, which Vite
 * inlined into the production bundle, handing every visitor full read/write/
 * delete over the candidate corpus. All search traffic is now proxied through
 * /api/meili/search, which is authenticated and keeps the key server-side.
 */

interface MeiliSearchResponse<T> {
  hits: T[];
  estimatedTotalHits?: number;
  totalHits?: number;
}

interface MeiliProxyParams {
  index: string;
  query: string;
  limit: number;
  offset: number;
  filter?: string;
}

async function meiliProxy<T>(
  params: MeiliProxyParams,
  signal?: AbortSignal,
): Promise<MeiliSearchResponse<T>> {
  const res = await fetch('/api/meili/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  return (await res.json()) as MeiliSearchResponse<T>;
}

export const DEFAULT_ATTRIBUTES = [
  'id',
  'name',
  'profile_url',
  'headline',
  'location',
  'current_company',
  'summary',
  'latest_role',
  'experience',
  'education',
];

export interface SearchHit {
  id?: string;
  name?: string;
  profile_url?: string;
  headline?: string;
  location?: string;
  current_company?: string;
  summary?: string;
  latest_role?: string;
  experience?: string;
  education?: string;
}

export interface BooleanHit {
  tree_score?: number;
  pipeline_score?: number;
  candidate_email?: string;
  candidate_phone?: string;
  folder_id: string;
  full_name?: string;
  resume_drive_view_url?: string;
  ai_latest_role?: string;
  ai_latest_company?: string;
  ai_latest_location?: string;
  resume_text_excerpt?: string;
  candidate_summary?: string;
  education?: string;
}

interface DocStore {
  [id: string]: SearchHit;
}

interface DocRank {
  [id: string]: number;
}

/**
 * Monotonic counter for insertion order.
 *
 * B13: rank was previously derived as `Object.keys(docRank).length`, which
 * walks the whole object on every hit — O(n) inside an O(n) loop, so O(n²)
 * overall. With perTermLimit defaulting to 5 000 documents per term that is
 * tens of millions of operations on the main thread.
 */
class RankCounter {
  private next = 0;
  take(): number {
    return this.next++;
  }
}

// NOTE: the browser no longer calls updateSettings. Raising Meilisearch's
// maxTotalHits is a privileged settings write, and needing it was precisely
// why the client had to carry an admin-grade key. It now runs once on the
// server at startup instead.

function parseExperienceYears(expStr?: string): number {
  if (!expStr) return 0;

  const text = expStr.toLowerCase();
  let totalYears = 0;

  // Extract all year matches
  const yrMatches = text.matchAll(/(\d+)\s*yrs?/g);
  for (const match of yrMatches) {
    totalYears += parseInt(match[1], 10);
  }

  // Extract all month matches
  const moMatches = text.matchAll(/(\d+)\s*mos?/g);
  for (const match of moMatches) {
    totalYears += parseInt(match[1], 10) / 12.0;
  }

  return totalYears;
}

async function searchTerm(
  term: string,
  perTermLimit: number,
  docStore: DocStore,
  docRank: DocRank,
  ranker: RankCounter,
  filter?: string,
  indexes = ['profiles', 'candidates'],
): Promise<Set<string>> {
  const ids = new Set<string>();
  const PAGE_SIZE = 1000;

  for (const indexName of indexes) {
    try {
      let offset = 0;
      let totalFetched = 0;

      while (totalFetched < perTermLimit) {
        const limit = Math.min(PAGE_SIZE, perTermLimit - totalFetched);
        const response = await meiliProxy<SearchHit>({
          index: indexName,
          query: `("${term}")`,
          limit,
          offset,
          filter,
        });

        const hits = response.hits || [];
        if (hits.length === 0) break;

        for (const hit of hits) {
          const hitId = hit.id || hit.profile_url;
          if (!hitId) continue;

          ids.add(hitId);
          if (!docStore[hitId]) {
            docStore[hitId] = hit;
            docRank[hitId] = ranker.take(); // O(1), was O(n)
          }
        }

        offset += hits.length;
        totalFetched += hits.length;
        if (hits.length < limit) break; // Reached the end of available hits
      }
    } catch (err) {
      console.warn(`Index ${indexName} failed for term [${term}]`, err);
    }
  }
  return ids;
}

async function gatherTermSets(
  terms: string[],
  perTermLimit: number,
  docStore: DocStore,
  docRank: DocRank,
  ranker: RankCounter,
  filter?: string,
): Promise<Set<string>[]> {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t);
  const promises = cleaned.map((term) =>
    searchTerm(term, perTermLimit, docStore, docRank, ranker, filter),
  );
  return Promise.all(promises);
}

function combineSets(
  shouldSets: Set<string>[],
  mustSets: Set<string>[],
  mustNotSets: Set<string>[],
): Set<string> {
  let working: Set<string> | null = null;

  if (shouldSets.length > 0) {
    working = new Set<string>();
    for (const s of shouldSets) {
      for (const item of Array.from(s)) {
        working.add(item);
      }
    }
  }

  if (mustSets.length > 0) {
    // B22: the previous guard read
    //   if (working === null || working.size === 0) { if (working === null) ... }
    // where the `working.size === 0` arm could never do anything. Seeding from
    // the first MUST set when there are no SHOULD terms is the actual intent;
    // an empty `working` after SHOULD terms correctly yields no results.
    if (working === null) {
      working = new Set<string>(mustSets[0]);
    }

    for (const s of mustSets) {
      // Intersect: only keep items present in 's'
      const nextWorking = new Set<string>();
      for (const item of Array.from(working)) {
        if (s.has(item)) nextWorking.add(item);
      }
      working = nextWorking;
    }
  }

  if (working === null) {
    working = new Set<string>();
  }

  if (mustNotSets.length > 0) {
    const forbidden = new Set<string>();
    for (const s of mustNotSets) {
      for (const item of Array.from(s)) {
        forbidden.add(item);
      }
    }
    const filtered = new Set<string>();
    for (const item of Array.from(working)) {
      if (!forbidden.has(item)) filtered.add(item);
    }
    working = filtered;
  }

  return working;
}

export interface SearchQuery {
  should?: string[];
  must?: string[];
  mustNot?: string[];
  andGroups?: string[][];
  limit?: number;
  perTermLimit?: number;
  minExp?: number;
  maxExp?: number;
  minMonthsInCurrentRole?: number;
  excludeCompanies?: string[];
  currentRoleKeywords?: string[];
  locationKeywords?: string[];
}

export async function runBooleanSearch(query: SearchQuery): Promise<{
  hits: BooleanHit[];
  total: number;
  totalIsCapped?: boolean;
  uniqueLocations: string[];
}> {
  const shouldTerms = query.should || [];
  const mustTerms = query.must || [];
  const mustNotTerms = query.mustNot || [];
  const andGroups = query.andGroups || [];
  const limit = query.limit || 25;
  const perTermLimit = query.perTermLimit || 5000;

  const docStore: DocStore = {};
  const docRank: DocRank = {};
  const ranker = new RankCounter();

  // Build Meilisearch filter (only numeric/exact filters go here)
  const filterParts: string[] = [];
  if (query.minMonthsInCurrentRole) {
    filterParts.push(`months_in_current_role >= ${query.minMonthsInCurrentRole}`);
  }
  // Location filtering is handled as post-search filtering (partial/contains match)
  // since locations are now region-level (e.g. "Tokyo") but documents have full strings
  // like "Minato-ku, Tokyo, Japan"
  // Note: excludeCompanies is handled as post-search filtering (starts-with match)
  const meiliFilter = filterParts.length > 0 ? filterParts.join(' AND ') : undefined;

  const [shouldSets, extractedMustSets, mustNotSets, groupResults] = await Promise.all([
    gatherTermSets(shouldTerms, perTermLimit, docStore, docRank, ranker, meiliFilter),
    gatherTermSets(mustTerms, perTermLimit, docStore, docRank, ranker, meiliFilter),
    gatherTermSets(mustNotTerms, perTermLimit, docStore, docRank, ranker, meiliFilter),
    Promise.all(
      andGroups.map((group) =>
        gatherTermSets(group, perTermLimit, docStore, docRank, ranker, meiliFilter),
      ),
    ),
  ]);

  const mustSets = [...extractedMustSets];

  if (andGroups.length > 0) {
    for (const groupSets of groupResults) {
      const unionSet = new Set<string>();
      for (const s of groupSets) {
        for (const item of Array.from(s)) unionSet.add(item);
      }
      // Always push the unionSet, even if empty, so an empty AND group correctly zeroes the results.
      mustSets.push(unionSet);
    }
  }

  if (shouldTerms.length === 0 && mustTerms.length === 0 && andGroups.length === 0) {
    // If there are absolutely no keywords provided, we just want to fetch based on location/filters
    const allSet = await searchTerm('', perTermLimit, docStore, docRank, ranker, meiliFilter);
    shouldSets.push(allSet);
  }
  if (shouldSets.length === 0 && mustSets.length === 0) {
    // If the user provided terms but Meilisearch found exactly 0 documents for all of them,
    // it means there are no matches. We should return 0 hits cleanly instead of erroring out.
    return { hits: [], total: 0, uniqueLocations: [] };
  }

  const matchingIds = combineSets(shouldSets, mustSets, mustNotSets);
  const orderedIds = Array.from(matchingIds).sort((a, b) => {
    const r1 = docRank[a] !== undefined ? docRank[a] : Number.POSITIVE_INFINITY;
    const r2 = docRank[b] !== undefined ? docRank[b] : Number.POSITIVE_INFINITY;
    return r1 - r2;
  });

  let filteredIds = orderedIds;

  // Post-search filter: exclude candidates whose current_company starts with any excluded company name
  if (query.excludeCompanies && query.excludeCompanies.length > 0) {
    const excludeLower = query.excludeCompanies.map((c) => c.toLowerCase());
    filteredIds = filteredIds.filter((hitId) => {
      const doc = docStore[hitId];
      if (!doc || !doc.current_company) return true; // keep if no company info
      const company = doc.current_company.toLowerCase();
      return !excludeLower.some((exc) => company.startsWith(exc));
    });
  }

  if (query.minExp !== undefined || query.maxExp !== undefined) {
    filteredIds = filteredIds.filter((hitId) => {
      const doc = docStore[hitId];
      if (!doc) return false;

      const expYears = parseExperienceYears(doc.experience);
      if (query.minExp !== undefined && expYears < query.minExp) return false;
      if (query.maxExp !== undefined && expYears > query.maxExp) return false;

      return true;
    });
  }

  if (query.currentRoleKeywords && query.currentRoleKeywords.length > 0) {
    const keywordsLower = query.currentRoleKeywords.map((k) => k.toLowerCase());
    filteredIds = filteredIds.filter((hitId) => {
      const doc = docStore[hitId];
      if (!doc || !doc.latest_role) return false;
      const latestRole = doc.latest_role.toLowerCase();
      return keywordsLower.some((kw) => latestRole.includes(kw));
    });
  }

  // Post-search filter: location contains matching (region-level)
  if (query.locationKeywords && query.locationKeywords.length > 0) {
    const locLower = query.locationKeywords.map((l) => l.toLowerCase());
    filteredIds = filteredIds.filter((hitId) => {
      const doc = docStore[hitId];
      if (!doc || !doc.location) return false;
      const docLoc = doc.location.toLowerCase();
      return locLower.some((loc) => docLoc.includes(loc));
    });
  }

  // Capture unique locations BEFORE slicing
  const uniqueLocations = Array.from(
    new Set(filteredIds.map((hitId) => docStore[hitId]?.location).filter(Boolean)),
  ).sort() as string[];

  const limitedIds = filteredIds.slice(0, limit);
  const finalHits: BooleanHit[] = [];

  for (const hitId of limitedIds) {
    const doc = docStore[hitId];
    if (!doc) continue;

    finalHits.push({
      folder_id: hitId,
      full_name: doc.name || hitId,
      resume_drive_view_url: doc.profile_url || '',
      candidate_summary: doc.summary || 'No summary available',
      ai_latest_role: doc.latest_role || 'Unknown Role',
      ai_latest_company: doc.current_company || 'Unknown Company',
      ai_latest_location: doc.location || 'Unknown Location',
      resume_text_excerpt: doc.experience || 'No experience available',
      education: doc.education || '',
    });
  }

  return {
    hits: finalHits,
    total: filteredIds.length,
    uniqueLocations: uniqueLocations,
  };
}

export async function getAvailableLocations(): Promise<string[]> {
  try {
    const API_BASE_URL = ''; // Relative to origin
    const res = await fetch(`${API_BASE_URL}/api/locations`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch locations');
    const data = await res.json();
    return data.locations || [];
  } catch (e) {
    console.warn(`Could not fetch locations from backend`, e);
    return [];
  }
}

export async function runSqlBooleanSearch(query: SearchQuery): Promise<{
  hits: BooleanHit[];
  total: number;
  totalIsCapped?: boolean;
  uniqueLocations: string[];
}> {
  const API_BASE_URL = ''; // using relative path for now

  const payload = {
    should: query.should,
    must: query.must,
    mustNot: query.mustNot,
    andGroups: query.andGroups,
    locations: query.locationKeywords || [],
    limit: query.limit,
    minExp: query.minExp,
    maxExp: query.maxExp,
    excludeCompanies: query.excludeCompanies,
    currentRoleKeywords: query.currentRoleKeywords,
  };

  const response = await fetch(`${API_BASE_URL}/api/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errStr = 'Failed to run SQL search';
    try {
      const errJson = await response.json();
      errStr = errJson.error || errStr;
    } catch {
      // Response body was not JSON; keep the generic message.
    }
    throw new Error(errStr);
  }

  const data = await response.json();
  return {
    hits: data.hits,
    total: data.total,
    // B32: true when the server stopped counting at its cap, so `total` is a
    // floor ("10,000+"), never an exact figure.
    totalIsCapped: data.totalIsCapped === true,
    uniqueLocations: query.locationKeywords || [],
  };
}
