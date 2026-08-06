/**
 * goldenSet.ts — bootstrap ground truth from decisions already made.
 *
 * You cannot improve screening accuracy without measuring it, and measuring it
 * needs labels: for a given (candidate, JD) pair, what SHOULD the answer have
 * been? Hand-labelling those from scratch is the usual reason this never gets
 * done.
 *
 * It does not have to start from scratch here. The system has been running for
 * a while and has accumulated:
 *
 *   screening_results   ~58k machine verdicts across 21 campaigns
 *   outreach_history    ~10k people a recruiter actually contacted
 *
 * The second table is the interesting one. Contacting someone is a human
 * action taken AFTER the machine said PASS — a person looked at the shortlist
 * and chose to act. That is a weak but real signal about whether the machine
 * was right, and it is the only human judgement in the system.
 *
 * ── What these labels are and are not ────────────────────────────────────────
 *
 * They are WEAK. Specifically:
 *
 *   - A PASS that was never contacted may mean "bad match", or it may mean the
 *     recruiter ran out of time, filled the role, or worked top-down and never
 *     reached row 80. Absence of contact is not evidence of unsuitability.
 *   - A REJECT is never in the label set at all, because nobody ever looked at
 *     it. The machine's false NEGATIVES are therefore invisible here — recall
 *     computed against this set is an upper bound, not a measurement.
 *
 * So this is a starting point that makes the eval loop runnable today, and the
 * labels it emits are marked with their source and a confidence so a human
 * review can supersede them. Promote to `human_review` before trusting any of
 * this as a release gate.
 */
import { pool } from '../repositories/postgres_repo';
import { hashJd } from '../repositories/screening_repo';
import { logInfo } from '../utils/logger';

export type LabelSource = 'human_review' | 'contacted' | 'not_contacted' | 'legacy_verdict';

export interface MinedLabel {
  profileUrl: string;
  jdHash: string;
  companyName: string;
  jobName: string;
  label: 'FIT' | 'NOT_FIT';
  source: LabelSource;
  confidence: number;
}

/** Weights reflecting how much each signal should be trusted. */
const CONFIDENCE: Record<LabelSource, number> = {
  human_review: 1.0,
  // A recruiter chose to contact this person off the shortlist.
  contacted: 0.8,
  // Passed screening and was never contacted. Genuinely ambiguous — it may
  // just mean the recruiter stopped reading. Deliberately low.
  not_contacted: 0.3,
  legacy_verdict: 0.1,
};

/**
 * Mines weak labels from screening + outreach history.
 *
 * @param jdTextByCampaign maps "company::job" to the JD text used, so labels
 *        can be keyed by the same hash the pipeline uses. Campaigns with no
 *        known JD text are skipped rather than guessed at.
 */
export async function mineWeakLabels(
  jdTextByCampaign: ReadonlyMap<string, string>,
): Promise<MinedLabel[]> {
  const client = await pool.connect();
  try {
    // One row per (candidate, campaign) that the old engine passed, joined to
    // whether anyone was subsequently contacted about them.
    const res = await client.query(
      `SELECT sr.profile_url,
              sr.company_name,
              sr.job_name,
              sr.verdict,
              (oh.profile_url IS NOT NULL) AS was_contacted
       FROM   screening_results sr
       LEFT JOIN LATERAL (
         SELECT 1 AS profile_url
         FROM   outreach_history o
         WHERE  o.profile_url  = sr.profile_url
           AND  o.company_name = sr.company_name
         LIMIT 1
       ) oh ON true
       WHERE  sr.verdict = 'PASS'`,
    );

    const labels: MinedLabel[] = [];
    let skipped = 0;

    for (const row of res.rows) {
      const key = `${row.company_name as string}::${row.job_name as string}`;
      const jdText = jdTextByCampaign.get(key);
      // Without the JD there is no rubric to evaluate against, so the pair is
      // not usable as a label.
      if (!jdText) {
        skipped++;
        continue;
      }

      const contacted = row.was_contacted === true;
      const source: LabelSource = contacted ? 'contacted' : 'not_contacted';

      labels.push({
        profileUrl: row.profile_url as string,
        jdHash: hashJd(jdText),
        companyName: row.company_name as string,
        jobName: row.job_name as string,
        label: contacted ? 'FIT' : 'NOT_FIT',
        source,
        confidence: CONFIDENCE[source],
      });
    }

    logInfo('weak_labels_mined', {
      candidates: res.rowCount,
      labelled: labels.length,
      skippedNoJd: skipped,
      fit: labels.filter((l) => l.label === 'FIT').length,
    });

    return labels;
  } finally {
    client.release();
  }
}

/** Persists labels, leaving any existing human review in place. */
export async function saveLabels(labels: readonly MinedLabel[]): Promise<number> {
  if (labels.length === 0) return 0;

  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO eval_labels
         (profile_url, jd_hash, company_name, job_name, label, source, confidence)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[]
       )
       ON CONFLICT (profile_url, jd_hash) DO UPDATE SET
         label      = EXCLUDED.label,
         source     = EXCLUDED.source,
         confidence = EXCLUDED.confidence
       -- A human review outranks anything mined. Without this guard a re-run
       -- of the miner would silently overwrite the labels that actually matter.
       WHERE eval_labels.source <> 'human_review'`,
      [
        labels.map((l) => l.profileUrl),
        labels.map((l) => l.jdHash),
        labels.map((l) => l.companyName),
        labels.map((l) => l.jobName),
        labels.map((l) => l.label),
        labels.map((l) => l.source),
        labels.map((l) => l.confidence),
      ],
    );
    return res.rowCount ?? 0;
  } finally {
    client.release();
  }
}

export interface GoldenPair {
  profileUrl: string;
  jdHash: string;
  companyName: string;
  jobName: string;
  label: 'FIT' | 'NOT_FIT';
  source: LabelSource;
  confidence: number;
}

/** Loads the label set, optionally restricted to trustworthy sources. */
export async function loadGoldenSet(
  opts: {
    minConfidence?: number;
    sources?: readonly LabelSource[];
    limit?: number;
  } = {},
): Promise<GoldenPair[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT profile_url, jd_hash, company_name, job_name, label, source, confidence
       FROM   eval_labels
       WHERE  confidence >= $1
         AND  ($2::text[] IS NULL OR source = ANY($2::text[]))
       ORDER  BY confidence DESC, id
       LIMIT  $3`,
      [
        opts.minConfidence ?? 0,
        opts.sources && opts.sources.length > 0 ? [...opts.sources] : null,
        opts.limit ?? 5000,
      ],
    );

    return res.rows.map((r) => ({
      profileUrl: r.profile_url as string,
      jdHash: r.jd_hash as string,
      companyName: r.company_name as string,
      jobName: r.job_name as string,
      label: r.label as 'FIT' | 'NOT_FIT',
      source: r.source as LabelSource,
      confidence: Number(r.confidence),
    }));
  } finally {
    client.release();
  }
}
