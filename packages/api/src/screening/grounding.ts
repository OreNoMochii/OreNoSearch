/**
 * grounding.ts — verifies that quoted evidence actually exists in the source.
 *
 * Every screening prompt in this codebase asks the model for "verbatim quotes
 * from the candidate profile", and nothing ever checked. The quote was parsed
 * into the schema, written into `reasoning`, shown to a recruiter, and used to
 * justify a PASS — on the model's word alone. A fabricated quote is therefore
 * indistinguishable from a real one, and it is exactly the failure mode that
 * produces a confident false positive.
 *
 * Instructions cannot fix this; only checking can. This module is that check,
 * and it is deliberately deterministic code rather than another model call.
 */

/**
 * Normalises text for comparison.
 *
 * Models reliably reproduce the WORDS of a quote and unreliably reproduce its
 * whitespace, punctuation, capitalisation and unicode dashes/quotes — a quote
 * lifted across a line break commonly comes back with the newline collapsed to
 * a space. Comparing raw strings would reject those as fabricated, so the
 * comparison is on a normalised form: case-folded, punctuation-stripped,
 * whitespace-collapsed.
 *
 * This is deliberately lenient about form and strict about content. A model
 * cannot pass this check by inventing facts, only by paraphrasing formatting.
 */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote too short to be evidence of anything. */
const MIN_QUOTE_CHARS = 8;

/**
 * Sentinel the prompts instruct the model to use when it finds nothing.
 * An honest "no evidence" is a valid answer and must not be flagged as a
 * fabrication — it is the behaviour we want to encourage.
 */
const NO_EVIDENCE_MARKERS = [
  'no evidence found',
  'no evidence',
  'not found',
  'none',
  'n/a',
  'not provided',
  'not specified',
];

export type GroundingStatus =
  /** The quote was located in the source text. */
  | 'verified'
  /** The model explicitly reported having no evidence. Honest, not a failure. */
  | 'abstained'
  /** Too short to carry meaning; not counted either way. */
  | 'trivial'
  /** The quote does not appear in the source. Treated as fabricated. */
  | 'unverified';

export interface GroundedQuote {
  readonly quote: string;
  readonly status: GroundingStatus;
}

/**
 * Checks one quote against the candidate's own text.
 *
 * `source` should be everything the model was shown — concatenating the fields
 * is correct, because a quote spanning two fields is still the candidate's own
 * text and should not be rejected on a technicality.
 */
export function verifyQuote(quote: string, normalisedSource: string): GroundingStatus {
  const trimmed = (quote ?? '').trim();
  if (trimmed.length === 0) return 'abstained';

  const lowered = trimmed.toLowerCase();
  if (NO_EVIDENCE_MARKERS.some((m) => lowered === m || lowered.startsWith(m))) {
    return 'abstained';
  }

  if (trimmed.length < MIN_QUOTE_CHARS) return 'trivial';

  const needle = normaliseForMatch(trimmed);
  if (needle.length === 0) return 'trivial';

  return normalisedSource.includes(needle) ? 'verified' : 'unverified';
}

/** Concatenates the candidate fields a model may legitimately quote from. */
export function buildQuotableSource(candidate: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of [
    'name',
    'headline',
    'latest_role',
    'current_company',
    'location',
    'summary',
    'experience',
    'education',
    'skills',
    'language',
    'licenses',
  ]) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value);
  }
  return normaliseForMatch(parts.join('\n'));
}

export interface GroundingReport {
  readonly quotes: readonly GroundedQuote[];
  readonly verified: number;
  readonly unverified: number;
  readonly abstained: number;
  /**
   * True when the model produced at least one quote that is not in the source.
   *
   * The caller decides what to do with it. The agentic pipeline discards those
   * quotes before scoring; the legacy single-call agent uses it to veto a PASS,
   * because there a fabricated quote may have been the whole basis of it.
   */
  readonly hasFabrication: boolean;
}

/** Verifies a set of quotes against one candidate. */
export function verifyQuotes(
  quotes: readonly string[],
  candidate: Record<string, unknown>,
): GroundingReport {
  const source = buildQuotableSource(candidate);
  const results: GroundedQuote[] = quotes.map((quote) => ({
    quote,
    status: verifyQuote(quote, source),
  }));

  let verified = 0;
  let unverified = 0;
  let abstained = 0;
  for (const r of results) {
    if (r.status === 'verified') verified++;
    else if (r.status === 'unverified') unverified++;
    else if (r.status === 'abstained') abstained++;
  }

  return {
    quotes: results,
    verified,
    unverified,
    abstained,
    hasFabrication: unverified > 0,
  };
}
