import { describe, it, expect } from 'vitest';
import { applyGates } from './gates';
import { parseTotalExperienceMonths } from './experience';
import type { JdRubric } from './schemas';
import type { ScreenedCandidate } from '../domain/ports';

const rubric = (over: Partial<JdRubric> = {}): JdRubric => ({
  role_title: 'BD Manager',
  role_summary: 'Business development for APAC.',
  seniority_band: 'senior',
  min_years_experience: 5,
  max_years_experience: null,
  knockouts: [],
  competencies: [{ id: 'c_1', requirement: 'Enterprise sales', weight: 1, evidence_hint: '' }],
  adjacent_roles: [],
  anti_signals: [],
  open_questions: [],
  ...over,
});

const candidate = (over: Partial<ScreenedCandidate> = {}): ScreenedCandidate => ({
  profileUrl: 'https://example.com/in/x',
  name: 'Test Person',
  currentCompany: 'Acme Corp',
  location: 'Tokyo, Japan',
  headline: 'Business Development Manager',
  experience: '8 yrs 3 mos at Acme',
  ...over,
});

describe('experience parsing', () => {
  it('sums years and months', () => {
    expect(parseTotalExperienceMonths('5 yrs 2 mos')).toBe(62);
  });

  it('sums across several roles', () => {
    expect(parseTotalExperienceMonths('3 yrs\n2 yrs 6 mos')).toBe(66);
  });

  it('distinguishes unparseable from zero', () => {
    // A resume we cannot parse must not look like a zero-experience candidate,
    // or the gates would reject qualified people on a formatting quirk.
    expect(parseTotalExperienceMonths('')).toBeNull();
    expect(parseTotalExperienceMonths(undefined)).toBeNull();
    expect(parseTotalExperienceMonths('no durations here')).toBeNull();
  });

  it('does not match "mo" inside a word (B31)', () => {
    // '03 - 8921252525 Mon - Wed' previously parsed as 8.9 billion months.
    expect(parseTotalExperienceMonths('03 - 8921252525 Mon - Wed')).toBeNull();
    expect(parseTotalExperienceMonths('978-3659116025 Monash University')).toBeNull();
  });

  it('matches the SQL function on an over-long number, quirk included', () => {
    // '99999 yrs' yields 999 years (11,988 months), not null and not 99,999:
    // the {1,3} bound makes the engine match the LAST three digits before the
    // unit rather than rejecting the token.
    //
    // That is a quirk, but it is the SQL function's quirk too — verified
    // against the live database. This port must agree with
    // calculate_total_experience_months exactly, because the same candidate is
    // filtered by the indexed `total_experience_months` column in one place and
    // by this function in another. A "better" parser here would make the gates
    // and the database disagree about who qualifies, which is worse than the
    // quirk. Changing it means changing both and backfilling 5.6M rows.
    expect(parseTotalExperienceMonths('99999 yrs')).toBe(11988);
  });

  it('returns null where the SQL returns 0, deliberately', () => {
    // The SQL function returns INTEGER and cannot express "nothing to parse",
    // so it reports 0. Here the distinction is load-bearing: applyGates must
    // pass an unparseable resume through to a model rather than treating it as
    // a zero-experience candidate and rejecting it.
    expect(parseTotalExperienceMonths('03 - 8921252525 Mon - Wed')).toBeNull();
  });
});

describe('deterministic gates', () => {
  it('passes a candidate meeting every constraint', () => {
    const r = applyGates(candidate(), rubric(), { minExpYears: 5 });
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it('rejects on insufficient experience with a numeric reason', () => {
    const r = applyGates(candidate({ experience: '2 yrs' }), rubric(), { minExpYears: 5 });
    expect(r.passed).toBe(false);
    expect(r.failures[0].knockoutId).toBe('campaign_min_exp');
    expect(r.failures[0].detail).toContain('2.0 years');
  });

  it('rejects an over-experienced candidate when a ceiling is set', () => {
    const r = applyGates(candidate({ experience: '30 yrs' }), rubric(), { maxExpYears: 10 });
    expect(r.passed).toBe(false);
    expect(r.failures[0].knockoutId).toBe('campaign_max_exp');
  });

  it('rejects an excluded current employer', () => {
    const r = applyGates(candidate({ currentCompany: 'Rakuten Japan' }), rubric(), {
      excludeCompanies: ['Rakuten'],
    });
    expect(r.passed).toBe(false);
    expect(r.failures[0].knockoutId).toBe('campaign_excluded_company');
  });

  it('rejects a location outside the campaign', () => {
    const r = applyGates(candidate({ location: 'Berlin, Germany' }), rubric(), {
      requiredLocations: ['Tokyo'],
    });
    expect(r.passed).toBe(false);
  });

  it('passes through rather than rejecting when data is missing', () => {
    // The load-bearing property of this stage: never reject on absent data.
    // A gate that guessed here would silently delete qualified candidates.
    const r = applyGates(candidate({ experience: undefined }), rubric(), { minExpYears: 5 });
    expect(r.passed).toBe(true);
  });

  it('marks an unevaluable structured knockout as indeterminate', () => {
    const r = applyGates(
      candidate({ location: undefined }),
      rubric({
        knockouts: [
          {
            id: 'ko_loc',
            requirement: 'Based in Japan',
            kind: 'structured',
            field: 'location',
            operator: 'includes_any',
            value: ['japan'],
          },
        ],
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.indeterminate).toContain('ko_loc');
  });

  it('applies a structured knockout from the rubric', () => {
    const r = applyGates(
      candidate({ experience: '1 yr' }),
      rubric({
        knockouts: [
          {
            id: 'ko_exp',
            requirement: '5+ years',
            kind: 'structured',
            field: 'total_experience_months',
            operator: 'gte',
            value: 60,
          },
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0].knockoutId).toBe('ko_exp');
  });

  it('ignores evidence-kind knockouts — those need the resume read', () => {
    const r = applyGates(
      candidate(),
      rubric({
        knockouts: [{ id: 'ko_ev', requirement: 'Has sold into pharmacies', kind: 'evidence' }],
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.indeterminate).not.toContain('ko_ev');
  });
});
