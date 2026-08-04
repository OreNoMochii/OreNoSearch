import { describe, it, expect } from 'vitest';
import { parseExperienceYears, combineSets } from './searchClient';

describe('parseExperienceYears', () => {
  it('returns 0 for empty or undefined input', () => {
    expect(parseExperienceYears(undefined)).toBe(0);
    expect(parseExperienceYears('')).toBe(0);
  });

  it('sums years across every listed role', () => {
    // The client mirrors the server's "total career experience" semantics,
    // not "duration of the first role".
    expect(parseExperienceYears('5 yrs 3 yrs 2 yrs')).toBe(10);
  });

  it('converts months to fractional years', () => {
    expect(parseExperienceYears('6 mos')).toBeCloseTo(0.5, 5);
    expect(parseExperienceYears('1 yr 6 mos')).toBeCloseTo(1.5, 5);
  });

  it('accepts singular and plural units', () => {
    expect(parseExperienceYears('1 yr')).toBe(1);
    expect(parseExperienceYears('2 yrs')).toBe(2);
    expect(parseExperienceYears('1 mo')).toBeCloseTo(1 / 12, 5);
    expect(parseExperienceYears('2 mos')).toBeCloseTo(2 / 12, 5);
  });

  it('is case-insensitive', () => {
    expect(parseExperienceYears('5 YRS')).toBe(5);
    expect(parseExperienceYears('5 Yrs')).toBe(5);
  });

  it('returns 0 when no duration is present', () => {
    expect(parseExperienceYears('Senior Engineer at Acme')).toBe(0);
  });

  it('tolerates absent whitespace between value and unit', () => {
    expect(parseExperienceYears('5yrs')).toBe(5);
  });
});

describe('combineSets', () => {
  const S = (...v: string[]) => new Set(v);

  describe('SHOULD (union)', () => {
    it('unions every should set', () => {
      const out = combineSets([S('a', 'b'), S('b', 'c')], [], []);
      expect([...out].sort()).toEqual(['a', 'b', 'c']);
    });

    it('returns empty when all should sets are empty', () => {
      expect(combineSets([S(), S()], [], []).size).toBe(0);
    });
  });

  describe('MUST (intersection)', () => {
    it('seeds from the first must set when there are no should terms', () => {
      // B22: the original guard had an unreachable branch here, so this
      // path is worth pinning down.
      const out = combineSets([], [S('a', 'b'), S('b', 'c')], []);
      expect([...out]).toEqual(['b']);
    });

    it('intersects should with must', () => {
      const out = combineSets([S('a', 'b', 'c')], [S('b', 'c'), S('c')], []);
      expect([...out]).toEqual(['c']);
    });

    it('yields empty when the intersection is empty', () => {
      expect(combineSets([], [S('a'), S('b')], []).size).toBe(0);
    });

    it('treats an empty must set as matching nothing', () => {
      // An AND group that found no documents must zero the result rather
      // than being silently ignored.
      expect(combineSets([S('a', 'b')], [S()], []).size).toBe(0);
    });
  });

  describe('MUST NOT (difference)', () => {
    it('removes forbidden ids', () => {
      const out = combineSets([S('a', 'b', 'c')], [], [S('b')]);
      expect([...out].sort()).toEqual(['a', 'c']);
    });

    it('unions multiple must-not sets before subtracting', () => {
      const out = combineSets([S('a', 'b', 'c')], [], [S('a'), S('c')]);
      expect([...out]).toEqual(['b']);
    });

    it('can empty the result entirely', () => {
      expect(combineSets([S('a')], [], [S('a')]).size).toBe(0);
    });

    it('applies after the must intersection, not before', () => {
      const out = combineSets([S('a', 'b')], [S('a', 'b')], [S('a')]);
      expect([...out]).toEqual(['b']);
    });
  });

  describe('degenerate input', () => {
    it('returns empty when given nothing', () => {
      expect(combineSets([], [], []).size).toBe(0);
    });

    it('returns empty when only must-not is supplied', () => {
      // Nothing was selected, so there is nothing to exclude from.
      expect(combineSets([], [], [S('a')]).size).toBe(0);
    });

    it('does not mutate its inputs', () => {
      const should = S('a', 'b');
      const must = S('b');
      const not = S('a');
      combineSets([should], [must], [not]);
      expect([...should].sort()).toEqual(['a', 'b']);
      expect([...must]).toEqual(['b']);
      expect([...not]).toEqual(['a']);
    });
  });
});
