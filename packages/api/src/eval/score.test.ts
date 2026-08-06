import { describe, it, expect } from 'vitest';
import { scoreRun, compare, type ScoredPair } from './score';

const pair = (
  predicted: ScoredPair['predicted'],
  actual: ScoredPair['actual'],
  weight = 1,
): ScoredPair => ({ profileUrl: `u${Math.random()}`, predicted, actual, weight });

describe('scoreRun', () => {
  it('computes precision on PASS', () => {
    const m = scoreRun([
      pair('PASS', 'FIT'),
      pair('PASS', 'FIT'),
      pair('PASS', 'NOT_FIT'),
      pair('REJECT', 'NOT_FIT'),
    ]);
    expect(m.precisionOnPass).toBeCloseTo(2 / 3, 5);
    expect(m.wastedReviewRate).toBeCloseTo(1 / 3, 5);
  });

  it('excludes abstentions from precision', () => {
    // Abstaining is declining to answer, not answering wrongly. Counting it as
    // an error would make the system look worse for doing the safe thing.
    const m = scoreRun([
      pair('PASS', 'FIT'),
      pair('UNCERTAIN', 'NOT_FIT'),
      pair('UNCERTAIN', 'FIT'),
    ]);
    expect(m.precisionOnPass).toBe(1);
    expect(m.decided).toBe(1);
    expect(m.abstained).toBe(2);
    expect(m.abstentionRate).toBeCloseTo(2 / 3, 5);
  });

  it('weights weak labels proportionally', () => {
    // One confident correct call should outweigh a low-confidence wrong one.
    const m = scoreRun([pair('PASS', 'FIT', 1.0), pair('PASS', 'NOT_FIT', 0.3)]);
    expect(m.precisionOnPass).toBeCloseTo(1 / 1.3, 5);
  });

  it('handles an empty set without dividing by zero', () => {
    const m = scoreRun([]);
    expect(m.precisionOnPass).toBe(0);
    expect(m.recall).toBe(0);
    expect(m.f1).toBe(0);
  });

  it('counts a missed fit as a false negative', () => {
    const m = scoreRun([pair('REJECT', 'FIT'), pair('PASS', 'FIT')]);
    expect(m.falseNegatives).toBe(1);
    expect(m.recall).toBeCloseTo(0.5, 5);
  });
});

describe('compare', () => {
  const baseline = scoreRun([
    pair('PASS', 'FIT'),
    pair('PASS', 'NOT_FIT'),
    pair('PASS', 'NOT_FIT'),
    pair('REJECT', 'NOT_FIT'),
  ]);

  it('accepts a precision gain at modest abstention cost', () => {
    const candidate = scoreRun([
      pair('PASS', 'FIT'),
      pair('UNCERTAIN', 'NOT_FIT'),
      pair('REJECT', 'NOT_FIT'),
      pair('REJECT', 'NOT_FIT'),
    ]);
    const r = compare(baseline, candidate, { maxAbstentionIncrease: 0.5 });
    expect(r.improved).toBe(true);
  });

  it('rejects precision bought by abstaining on everything', () => {
    // The degenerate optimum: abstain on all but one, score 100% precision,
    // deliver nothing. The gate must not treat that as an improvement.
    const candidate = scoreRun([
      pair('PASS', 'FIT'),
      pair('UNCERTAIN', 'NOT_FIT'),
      pair('UNCERTAIN', 'NOT_FIT'),
      pair('UNCERTAIN', 'NOT_FIT'),
    ]);
    const r = compare(baseline, candidate, { maxAbstentionIncrease: 0.15 });
    expect(r.improved).toBe(false);
    expect(r.summary).toContain('abstention rose');
  });

  it('rejects a change with no precision gain', () => {
    const r = compare(baseline, baseline);
    expect(r.improved).toBe(false);
    expect(r.summary).toContain('no precision gain');
  });
});
