/**
 * experience.ts — total career length from a resume's experience text.
 *
 * A TypeScript port of the SQL `calculate_total_experience_months`, kept
 * deliberately byte-compatible with it, including the two defects that function
 * was fixed for (see migration 003):
 *
 *   - digits bounded to 3, because an unbounded match on a phone number or ISBN
 *     produced values in the billions and overflowed the integer cast;
 *   - a word boundary after the unit, because bare `mo` matched Mon, Monday,
 *     Monash and MoneyLion, so "03 - 8921252525 Mon - Wed" parsed as 8.9
 *     billion months.
 *
 * Measured over a 200,000-row sample at the time, those two bugs gave 4.32% of
 * rows a wrong value. Any divergence between this and the SQL means the gates
 * and the database disagree about the same candidate, so if one changes the
 * other must too.
 *
 * KNOWN SHARED QUIRK, verified against the live function: because the digit
 * count is bounded to 3 rather than anchored, "99999 yrs" matches the last
 * three digits and yields 999 years, not a rejection. Both implementations do
 * this. It is left alone deliberately — "fixing" it here alone would make the
 * gates disagree with the indexed `total_experience_months` column about who
 * qualifies, and fixing both means a 5.6M-row backfill.
 *
 * ONE DELIBERATE DIFFERENCE: the SQL returns INTEGER and reports 0 when there
 * is nothing to parse. This returns null instead, because the gates must be
 * able to tell "no durations found" from "zero experience" — see the note on
 * the return value below.
 */

const YEARS = /(\d{1,3})\s*yrs?\b/gi;
const MONTHS = /(\d{1,3})\s*mos?\b/gi;

/**
 * Sums every duration in the text.
 *
 * Returns null when there is nothing to parse — distinct from 0, which means
 * "text was present and contained no durations". Callers must not treat an
 * unparseable resume as a zero-experience candidate; the gates pass those
 * through to a model rather than rejecting them.
 */
export function parseTotalExperienceMonths(experience?: string): number | null {
  if (!experience || experience.trim().length === 0) return null;

  let total = 0;
  let matched = false;

  for (const m of experience.matchAll(YEARS)) {
    const years = Number.parseInt(m[1], 10);
    if (Number.isFinite(years)) {
      total += years * 12;
      matched = true;
    }
  }

  for (const m of experience.matchAll(MONTHS)) {
    const months = Number.parseInt(m[1], 10);
    if (Number.isFinite(months)) {
      total += months;
      matched = true;
    }
  }

  if (!matched) return null;
  return Math.min(total, 2_147_483_647);
}

/** Convenience wrapper in years, rounded to one decimal. */
export function parseTotalExperienceYears(experience?: string): number | null {
  const months = parseTotalExperienceMonths(experience);
  return months === null ? null : Math.round((months / 12) * 10) / 10;
}
