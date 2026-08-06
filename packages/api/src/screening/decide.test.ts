import { describe, it, expect } from 'vitest';
import { decide } from './decide';
import { computeWeightedScore } from './adjudicator';
import type { Adjudication, JdRubric } from './schemas';
import type { GateResult } from './gates';

const passedGates: GateResult = { passed: true, failures: [], indeterminate: [] };

const rubric: JdRubric = {
  role_title: 'BD Manager',
  role_summary: 'Business development.',
  seniority_band: 'senior',
  min_years_experience: 5,
  max_years_experience: null,
  knockouts: [{ id: 'ko_1', requirement: '5+ years in new business', kind: 'evidence' }],
  competencies: [
    { id: 'c_1', requirement: 'Enterprise sales', weight: 3, evidence_hint: '' },
    { id: 'c_2', requirement: 'Partnerships', weight: 1, evidence_hint: '' },
  ],
  adjacent_roles: [],
  anti_signals: [],
  open_questions: [],
};

const adjudication = (over: Partial<Adjudication> = {}): Adjudication => ({
  knockouts: [{ knockout_id: 'ko_1', satisfied: true, rationale: '' }],
  competencies: [
    { requirement_id: 'c_1', score: 4, rationale: '' },
    { requirement_id: 'c_2', score: 4, rationale: '' },
  ],
  seniority_assessment: '8 years',
  estimated_years: 8,
  ...over,
});

describe('weighted score', () => {
  it('is 1 when every competency is maxed', () => {
    expect(computeWeightedScore(adjudication(), rubric)).toBe(1);
  });

  it('is 0 when nothing is evidenced', () => {
    const a = adjudication({
      competencies: [
        { requirement_id: 'c_1', score: 0, rationale: '' },
        { requirement_id: 'c_2', score: 0, rationale: '' },
      ],
    });
    expect(computeWeightedScore(a, rubric)).toBe(0);
  });

  it('respects the rubric weights', () => {
    // c_1 has weight 3 of 4 total, scored 4/4 → 0.75.
    const a = adjudication({
      competencies: [
        { requirement_id: 'c_1', score: 4, rationale: '' },
        { requirement_id: 'c_2', score: 0, rationale: '' },
      ],
    });
    expect(computeWeightedScore(a, rubric)).toBeCloseTo(0.75, 5);
  });

  it('ignores scores for requirements not in the rubric', () => {
    // Otherwise a hallucinated requirement inflates the numerator against a
    // fixed denominator and can push a candidate over the line.
    const a = adjudication({
      competencies: [
        { requirement_id: 'c_1', score: 4, rationale: '' },
        { requirement_id: 'c_2', score: 4, rationale: '' },
        { requirement_id: 'invented', score: 4, rationale: '' },
      ],
    });
    expect(computeWeightedScore(a, rubric)).toBe(1);
  });
});

describe('decision', () => {
  it('passes a strong, evidenced candidate', () => {
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication(),
      weightedScore: 1,
      verifiedQuotes: 5,
    });
    expect(d.decision).toBe('PASS');
  });

  it('rejects on a failed deterministic gate before anything else', () => {
    const d = decide({
      rubric,
      gates: {
        passed: false,
        failures: [{ knockoutId: 'k', requirement: '5+ years', detail: '2.0 years found' }],
        indeterminate: [],
      },
      weightedScore: 1,
      verifiedQuotes: 9,
    });
    expect(d.decision).toBe('REJECT');
    expect(d.stage).toBe('gates');
  });

  it('lets a violated knockout override a perfect score', () => {
    // The old 1-5 average allowed a candidate to fail a stated must-have and
    // still come out a RETAIN on the strength of everything else.
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication({
        knockouts: [{ knockout_id: 'ko_1', satisfied: false, rationale: 'Only 2 years' }],
      }),
      weightedScore: 1,
      verifiedQuotes: 9,
    });
    expect(d.decision).toBe('REJECT');
    expect(d.stage).toBe('adjudicator');
  });

  it('abstains rather than guessing on an unresolved knockout', () => {
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication({
        knockouts: [{ knockout_id: 'ko_1', satisfied: null, rationale: 'Not stated' }],
      }),
      weightedScore: 0.9,
      verifiedQuotes: 4,
    });
    expect(d.decision).toBe('UNCERTAIN');
  });

  it('lets one verified fatal objection reject a high scorer', () => {
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication(),
      weightedScore: 0.95,
      verifiedQuotes: 6,
      challenge: {
        ok: true,
        verifiedFatal: 1,
        verifiedSerious: 0,
        discarded: 0,
        usage: { promptTokens: 0, completionTokens: 0, calls: 1 },
        challenge: {
          findings: [{ objection: 'No new-business experience', quote: 'q', severity: 'fatal' }],
          would_reject: true,
        },
      },
    });
    expect(d.decision).toBe('REJECT');
    expect(d.stage).toBe('challenger');
  });

  it('does not let the challenger promote anyone', () => {
    // A clean challenge is not evidence of fit — it is absence of evidence
    // against. A low scorer must stay rejected.
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication(),
      weightedScore: 0.2,
      verifiedQuotes: 2,
      challenge: {
        ok: true,
        verifiedFatal: 0,
        verifiedSerious: 0,
        discarded: 0,
        usage: { promptTokens: 0, completionTokens: 0, calls: 1 },
        challenge: { findings: [], would_reject: false },
      },
    });
    expect(d.decision).toBe('REJECT');
  });

  it('abstains when nothing at all could be verified', () => {
    // A respectable score built on zero verified quotes is the adjudicator
    // being generous about empty evidence, not a qualified candidate.
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication(),
      weightedScore: 0.95,
      verifiedQuotes: 0,
    });
    expect(d.decision).toBe('UNCERTAIN');
    expect(d.stage).toBe('evidence');
  });

  it('abstains inside the boundary band', () => {
    // Default threshold 0.7, band 0.12 → 0.60 is borderline.
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication(),
      weightedScore: 0.6,
      verifiedQuotes: 3,
    });
    expect(d.decision).toBe('UNCERTAIN');
  });

  it('rejects clearly below the band', () => {
    const d = decide({
      rubric,
      gates: passedGates,
      adjudication: adjudication(),
      weightedScore: 0.2,
      verifiedQuotes: 3,
    });
    expect(d.decision).toBe('REJECT');
  });

  it('abstains when a stage errored, rather than rejecting', () => {
    // A provider outage says nothing about the candidate.
    const d = decide({
      rubric,
      gates: passedGates,
      weightedScore: 0,
      verifiedQuotes: 0,
      stageFailure: 'adjudication failed',
    });
    expect(d.decision).toBe('UNCERTAIN');
  });
});
