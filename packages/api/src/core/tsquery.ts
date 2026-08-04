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
