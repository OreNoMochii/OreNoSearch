import { describe, it, expect } from 'vitest';
import { toTsQueryPhrase } from './tsquery';

describe('toTsQueryPhrase', () => {
  describe('B15 — tsquery operator injection', () => {
    // Each of these previously reached to_tsquery as an operator and made
    // Postgres raise "syntax error in tsquery", surfacing as a 500.
    it.each([
      ['!', ''],
      ['&', ''],
      ['|', ''],
      ['()', ''],
      [':', ''],
      ['<->', ''],
      ['   ', ''],
      ['', ''],
    ])('reduces bare operator %j to an empty fragment', (input, expected) => {
      expect(toTsQueryPhrase(input)).toBe(expected);
    });

    it('strips operators embedded among real words', () => {
      expect(toTsQueryPhrase('senior & engineer')).toBe("'senior' <-> 'engineer'");
      expect(toTsQueryPhrase('a|b')).toBe("'a' <-> 'b'");
      expect(toTsQueryPhrase('!(java)')).toBe("'java'");
    });

    it('neutralises a SQL-injection-shaped term', () => {
      // Not SQL injection (the value is parameterised) but it must not
      // reach the tsquery grammar either.
      expect(toTsQueryPhrase("'; DROP TABLE candidates--")).toBe(
        "'drop' <-> 'table' <-> 'candidates'",
      );
    });

    it('never emits an unbalanced quote', () => {
      for (const input of ["it's", "o'brien", "''", "a'b'c"]) {
        const out = toTsQueryPhrase(input);
        const quotes = (out.match(/'/g) ?? []).length;
        expect(quotes % 2, `unbalanced quotes for ${input}: ${out}`).toBe(0);
      }
    });
  });

  describe('language-name sentinels', () => {
    it('preserves names tokenisation would otherwise destroy', () => {
      expect(toTsQueryPhrase('c++')).toBe("'cpp_lang'");
      expect(toTsQueryPhrase('C++')).toBe("'cpp_lang'");
      expect(toTsQueryPhrase('c#')).toBe("'csharp_lang'");
      expect(toTsQueryPhrase('.net')).toBe("'dotnet_lang'");
      expect(toTsQueryPhrase('f#')).toBe("'fsharp_lang'");
    });

    it('handles a sentinel alongside other terms', () => {
      expect(toTsQueryPhrase('senior c++ developer')).toBe(
        "'senior' <-> 'cpp_lang' <-> 'developer'",
      );
    });
  });

  describe('normal terms', () => {
    it('phrase-matches multi-word input in order', () => {
      expect(toTsQueryPhrase('machine learning engineer')).toBe(
        "'machine' <-> 'learning' <-> 'engineer'",
      );
    });

    it('lowercases', () => {
      expect(toTsQueryPhrase('SENIOR Engineer')).toBe("'senior' <-> 'engineer'");
    });

    it('keeps digits and underscores', () => {
      expect(toTsQueryPhrase('python_3 dev')).toBe("'python_3' <-> 'dev'");
    });

    it('collapses runs of separators', () => {
      expect(toTsQueryPhrase('a   ---   b')).toBe("'a' <-> 'b'");
    });
  });
});
