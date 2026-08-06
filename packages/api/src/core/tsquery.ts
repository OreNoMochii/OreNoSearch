/**
 * tsquery.ts — user text -> PostgreSQL tsquery.
 *
 * Extracted from postgres_repo so it can be tested without opening a
 * connection pool (that module constructs a Pool at import time).
 */

/**
 * Reduces a user-supplied term to a phrase-matched tsquery lexeme sequence.
 *
 * B15: the original implementation quoted tokens but left the rest of the
 * string intact, so a term such as `!` or `&` reached the tsquery parser as an
 * operator and Postgres raised `syntax error in tsquery` — surfacing as an
 * unhandled 500. Stripping everything outside [a-z0-9_] makes operators
 * unrepresentable rather than merely escaped.
 *
 * Language names that tokenisation would otherwise destroy are mapped to
 * sentinels first; the same substitutions are applied to the indexed
 * expression so both sides agree.
 *
 * @returns a tsquery fragment, or '' when the term contains no usable lexeme.
 */
export function toTsQueryPhrase(term: string): string {
  const tokens = term
    .toLowerCase()
    .replace(/c\+\+/g, 'cpp_lang')
    .replace(/c#/g, 'csharp_lang')
    .replace(/\.net/g, 'dotnet_lang')
    .replace(/f#/g, 'fsharp_lang')
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `'${t}'`).join(' <-> ');
}

/**
 * Scripts that PostgreSQL's default parser cannot segment into words.
 *
 * Japanese, Chinese and Korean are written without spaces, so the `english`
 * (and `simple`) text-search parser treats an entire run of CJK characters as
 * ONE lexeme. Verified against the live database:
 *
 *   to_tsvector('english', '営業部長')            -> '営業部長':1
 *   to_tsvector('english','営業部長') @@ '営業'    -> false
 *
 * So a search for 営業 cannot match 営業部長 through tsquery no matter how the
 * term is escaped — full-text search is the wrong instrument for these scripts
 * without a segmenting extension such as pg_bigm or PGroonga.
 *
 * Covers hiragana, katakana (full and half width), CJK ideographs including
 * extension A, and Hangul — the same failure applies to all of them and the
 * candidate corpus contains all of them.
 */
const UNSEGMENTED_SCRIPT = /[぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯ᄀ-ᇿｦ-ﾝ]/;

export function containsUnsegmentedScript(term: string): boolean {
  return UNSEGMENTED_SCRIPT.test(term);
}

/**
 * How a term must be matched in SQL.
 *
 *   lexeme    — safe for to_tsquery; uses the full-text index
 *   substring — must be matched with ILIKE; tsquery cannot express it
 *   empty     — nothing usable in the term
 */
export type TermMatch =
  | { readonly kind: 'lexeme'; readonly value: string }
  | { readonly kind: 'substring'; readonly value: string }
  | { readonly kind: 'empty' };

/**
 * Decides how one user-supplied term has to be matched.
 *
 * This exists because the previous behaviour was silently wrong rather than
 * merely limited. `toTsQueryPhrase` strips everything outside [a-z0-9_], so a
 * Japanese term reduced to the empty string, was dropped by the caller's
 * `.filter(Boolean)`, and the condition simply disappeared from the WHERE
 * clause. A search for 営業 in Tokyo therefore returned every candidate in
 * Tokyo — 584,802 rows against a true 24,127 — with no error and no warning.
 *
 * Routing those terms to ILIKE is slower (no index serves a leading wildcard
 * over the concatenated text) but correct, and a correct answer in ~3s beats a
 * wrong one instantly.
 *
 * A term mixing scripts, e.g. "AI エンジニア", is treated as a substring in
 * full: partially tokenising it would silently change what the user asked for.
 */
export function classifyTerm(term: string): TermMatch {
  const trimmed = term.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  if (containsUnsegmentedScript(trimmed)) {
    return { kind: 'substring', value: trimmed };
  }

  const phrase = toTsQueryPhrase(trimmed);
  return phrase === '' ? { kind: 'empty' } : { kind: 'lexeme', value: phrase };
}
