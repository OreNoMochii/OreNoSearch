import { describe, it, expect } from 'vitest';
import { toTsQueryPhrase, classifyTerm, containsUnsegmentedScript } from './tsquery';

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

  describe('unsegmented scripts are not representable as lexemes', () => {
    it('reduces every CJK term to an empty fragment', () => {
      // Not a defect in this function — [a-z0-9_] cannot express CJK — but it
      // is why classifyTerm exists. Callers must NOT feed these to tsquery.
      for (const term of ['営業', 'エンジニア', '経理', '東京', '销售', '영업']) {
        expect(toTsQueryPhrase(term), term).toBe('');
      }
    });
  });
});

describe('containsUnsegmentedScript', () => {
  it('detects Japanese in all scripts', () => {
    expect(containsUnsegmentedScript('営業')).toBe(true); // kanji
    expect(containsUnsegmentedScript('エンジニア')).toBe(true); // katakana
    expect(containsUnsegmentedScript('えいぎょう')).toBe(true); // hiragana
    expect(containsUnsegmentedScript('ｴﾝｼﾞﾆｱ')).toBe(true); // halfwidth katakana
  });

  it('detects Chinese and Korean', () => {
    expect(containsUnsegmentedScript('销售')).toBe(true);
    expect(containsUnsegmentedScript('영업')).toBe(true);
  });

  it('does not fire on Latin, digits or punctuation', () => {
    for (const term of ['engineer', 'C++', 'business development', '3 years', 'k.k.', '.net']) {
      expect(containsUnsegmentedScript(term), term).toBe(false);
    }
  });

  it('fires on a mixed-script term', () => {
    expect(containsUnsegmentedScript('AI エンジニア')).toBe(true);
  });
});

describe('classifyTerm', () => {
  it('routes Latin terms to the full-text index', () => {
    expect(classifyTerm('engineer')).toEqual({ kind: 'lexeme', value: "'engineer'" });
    expect(classifyTerm('business development')).toEqual({
      kind: 'lexeme',
      value: "'business' <-> 'development'",
    });
  });

  it('routes Japanese terms to substring matching', () => {
    for (const term of ['営業', 'エンジニア', '経理', '部長', 'データサイエンティスト']) {
      expect(classifyTerm(term), term).toEqual({ kind: 'substring', value: term });
    }
  });

  it('NEVER drops a Japanese term', () => {
    // The regression guard for the defect this was written for.
    //
    // Japanese terms used to reduce to '' and were then removed by the
    // caller's .filter(Boolean), so the keyword condition disappeared from the
    // WHERE clause entirely. Measured on the live table: searching 営業
    // restricted to Tokyo returned 584,802 candidates against a true 24,127 —
    // every candidate in the region, with no error and no warning.
    //
    // An 'empty' verdict here means that term is silently ignored again.
    for (const term of ['営業', '東京', '株式会社', '販売', '看護師', '医師']) {
      expect(classifyTerm(term).kind, `"${term}" was silently dropped`).not.toBe('empty');
    }
  });

  it('treats a mixed-script term as one substring', () => {
    // Partially tokenising it would quietly change what the user asked for.
    expect(classifyTerm('AI エンジニア')).toEqual({ kind: 'substring', value: 'AI エンジニア' });
  });

  it('trims before classifying', () => {
    expect(classifyTerm('  engineer  ')).toEqual({ kind: 'lexeme', value: "'engineer'" });
    expect(classifyTerm('  営業  ')).toEqual({ kind: 'substring', value: '営業' });
  });

  it('reports genuinely unusable terms as empty', () => {
    for (const term of ['', '   ', '!', '&&&', '---']) {
      expect(classifyTerm(term).kind, JSON.stringify(term)).toBe('empty');
    }
  });
});
