import type { CandidateSource, CandidateSpec, RawCandidateRow } from '../domain/ports';
import { getCandidatesByUrl, runIlikeSearch } from '../repositories/postgres_repo';
import { logInfo } from '../utils/logger';

/**
 * Resolves a campaign's candidate set against the golden database.
 *
 * This exists so the rows stop making a round trip they never needed. The UI
 * used to re-run its search with `limit: 100000`, receive every matching row
 * (each carrying up to 50,000 characters of `experience`), serialise them, post
 * them back, and have the API persist them verbatim into Redis as the job body.
 * Now the campaign carries the *search*, and the rows are produced here — in
 * the worker, next to the data.
 */
export class PostgresCandidateSource implements CandidateSource {
  async resolve(spec: CandidateSpec, limit: number): Promise<readonly RawCandidateRow[]> {
    switch (spec.kind) {
      case 'search': {
        const started = Date.now();
        const { hits } = await runIlikeSearch({
          andGroups: spec.params.andGroups.map((g) => [...g]),
          must: [...spec.params.must],
          should: [...spec.params.should],
          mustNot: [...spec.params.mustNot],
          locations: [...spec.params.locations],
          minExp: spec.params.minExp,
          maxExp: spec.params.maxExp,
          excludeCompanies: spec.params.excludeCompanies
            ? [...spec.params.excludeCompanies]
            : undefined,
          currentRoleKeywords: spec.params.currentRoleKeywords
            ? [...spec.params.currentRoleKeywords]
            : undefined,
          limit,
          // Nothing here reads `total`, and the bounded count is the dominant
          // cost of a search (~1s at the configured cap).
          skipCount: true,
        });
        logInfo('candidates_resolved', {
          kind: 'search',
          resolved: hits.length,
          limit,
          durationMs: Date.now() - started,
        });
        return hits as RawCandidateRow[];
      }

      case 'urls': {
        const started = Date.now();
        const urls = spec.urls.slice(0, limit);
        const rows = await getCandidatesByUrl(urls);
        logInfo('candidates_resolved', {
          kind: 'urls',
          requested: urls.length,
          resolved: rows.length,
          durationMs: Date.now() - started,
        });
        return rows;
      }

      case 'inline':
        return spec.rows.slice(0, limit);
    }
  }
}
